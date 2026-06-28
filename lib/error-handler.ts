import Logger from "./logger"
import { getSettings, setSettings } from "./redis-db"

export interface ErrorContext {
  route?: string
  method?: string
  userId?: string
  component?: string
  action?: string
  metadata?: Record<string, any>
}

export class AppError extends Error {
  public readonly statusCode: number
  public readonly isOperational: boolean
  public readonly context?: ErrorContext

  constructor(message: string, statusCode = 500, isOperational = true, context?: ErrorContext) {
    super(message)
    this.statusCode = statusCode
    this.isOperational = isOperational
    this.context = context
    Error.captureStackTrace(this, this.constructor)
  }
}

export class ErrorHandler {
  private static instance: ErrorHandler
  private logger: Logger

  private constructor() {
    this.logger = Logger.getInstance()
  }

  public static getInstance(): ErrorHandler {
    if (!ErrorHandler.instance) {
      ErrorHandler.instance = new ErrorHandler()
    }
    return ErrorHandler.instance
  }

  public async handleError(error: Error | AppError, context?: ErrorContext): Promise<void> {
    console.error("[v0] Error occurred:", {
      message: error.message,
      stack: error.stack,
      context,
    })

    // Log to database
    await this.logger.logNextError(error, context)

    // If it's a critical error, you could send alerts here
    if (error instanceof AppError && !error.isOperational) {
      console.error("[v0] CRITICAL ERROR - Non-operational error occurred:", error)
      await this.sendAlert(error, context)
    }
  }

  private async sendAlert(error: AppError, context?: ErrorContext): Promise<void> {
    try {
      const alerts = (await getSettings("critical_alerts")) || []
      const alert = {
        id: `alert:${Date.now()}`,
        message: error.message,
        statusCode: error.statusCode,
        context,
        timestamp: new Date().toISOString(),
        stack: error.stack,
      }
      alerts.push(alert)
      if (alerts.length > 100) {
        alerts.shift()
      }
      await setSettings("critical_alerts", alerts)
      console.error("[v0] Alert sent to monitoring service:", alert.id)
    } catch (err) {
      console.error("[v0] Failed to send alert:", err)
    }
  }

  public async handleAPIError(error: Error | AppError, route: string, method: string): Promise<Response> {
    await this.handleError(error, { route, method })

    if (error instanceof AppError) {
      return new Response(
        JSON.stringify({
          error: error.message,
          statusCode: error.statusCode,
          context: error.context,
        }),
        {
          status: error.statusCode,
          headers: { "Content-Type": "application/json" },
        },
      )
    }

    return new Response(
      JSON.stringify({
        error: "Internal server error",
        message: error.message,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    )
  }

  public wrapAsync<T extends any[], R>(
    fn: (...args: T) => Promise<R>,
    context?: ErrorContext,
  ): (...args: T) => Promise<R> {
    return async (...args: T): Promise<R> => {
      try {
        return await fn(...args)
      } catch (error) {
        await this.handleError(error as Error, context)
        throw error
      }
    }
  }
}

export const errorHandler = ErrorHandler.getInstance()

// Global error handlers for uncaught errors.
//
// CRITICAL (Global Trade Coordinator stability): these handlers must NEVER
// exit the process. The coordinator is a long-lived singleton that owns every
// running engine; a `process.exit(1)` here kills ALL engines and (under
// `next start`/Vercel) forces a worker restart — exactly the "stopping /
// crashing / restarting" the operator reported, often triggered by a stray
// rejection in the settings-save → recoordination → engine start/stop chain.
//
// Instead we SURVIVE + SELF-HEAL in place: log the error, run it through the
// handler, and give every running engine a chance to re-arm its timers
// (mirrors the engine-manager's unhandledRejection self-heal). The once-guard
// prevents duplicate listeners when this module is imported by many routes.
if (typeof window === "undefined") {
  const g = globalThis as any
  if (!g.__v0_errorHandlerProcessHooks) {
    g.__v0_errorHandlerProcessHooks = true
    try { (process as any).setMaxListeners?.(50) } catch {}

    // Route a process-level error through the self-heal path WITHOUT exiting.
    const selfHeal = async (error: Error, action: string) => {
      try {
        await errorHandler.handleError(error, { component: "process", action })
      } catch {
        /* handler itself must never throw out of the global hook */
      }
      try {
        // Re-arm any running engines in place so a stray error never silently
        // stalls the loop. Best-effort: failures here are swallowed.
        const { getGlobalCoordinator } = await import("@/lib/trade-engine")
        const coord = getGlobalCoordinator?.()
        // @ts-expect-error - reach into the coordinator's manager map
        const managers: Map<string, any> | undefined = coord?.engineManagers
        if (managers) {
          for (const [, mgr] of managers.entries()) {
            if (!mgr?.isEngineRunning) continue
            try { await mgr.rearmIfStalled?.() } catch {}
          }
        }
      } catch {
        /* import/heal failure is non-fatal — staying alive is the priority */
      }
    }

    process.on("uncaughtException", (error: Error) => {
      // NON-FATAL by design. Do NOT call process.exit — see header.
      console.error("[v0] Uncaught Exception (non-fatal, self-healing):", error)
      void selfHeal(error, "uncaughtException")
    })

    process.on("unhandledRejection", (reason: any) => {
      console.error("[v0] Unhandled Rejection (non-fatal, self-healing):", reason)
      const error = reason instanceof Error ? reason : new Error(String(reason))
      void selfHeal(error, "unhandledRejection")
    })
  }
}

export default ErrorHandler
