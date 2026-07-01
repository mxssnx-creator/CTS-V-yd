declare module "bingx-api" {
  export interface BingXClientOptions {
    apiKey?: string
    secretKey?: string
    baseUrl?: string
    recvWindow?: number
    [key: string]: unknown
  }

  export class BingxApiClient {
    constructor(options?: BingXClientOptions)
    [key: string]: any
  }

  const BingXClient: typeof BingxApiClient
  export default BingXClient
}
