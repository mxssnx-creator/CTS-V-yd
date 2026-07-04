/**
 * Preset Types Seeder
 * Creates default preset types on initialization if they don't exist
 */

import { getRedisClient, initRedis } from "@/lib/redis-db"
import { nanoid } from "nanoid"

export const DEFAULT_PRESET_TYPES = [
  {
    name: "Conservative",
    description: "Low-risk strategy with minimal positions and long timeout",
    preset_trade_type: "automatic",
    max_positions_per_indication: 1,
    max_positions_per_direction: 2,
    max_positions_per_range: 3,
    timeout_per_indication: 10,
    timeout_after_position: 30,
    block_enabled: true,
    block_only: false,
    dca_enabled: false,
    dca_only: false,
    auto_evaluate: true,
    evaluation_interval_hours: 6,
    is_active: true,
  },
  {
    name: "Moderate",
    description: "Balanced strategy with moderate risk and mixed timeouts",
    preset_trade_type: "automatic",
    max_positions_per_indication: 2,
    max_positions_per_direction: 3,
    max_positions_per_range: 5,
    timeout_per_indication: 5,
    timeout_after_position: 15,
    block_enabled: true,
    block_only: false,
    dca_enabled: false,
    dca_only: false,
    auto_evaluate: true,
    evaluation_interval_hours: 3,
    is_active: true,
  },
  {
    name: "Aggressive",
    description: "High-risk strategy with many positions and short timeout",
    preset_trade_type: "automatic",
    max_positions_per_indication: 3,
    max_positions_per_direction: 5,
    max_positions_per_range: 10,
    timeout_per_indication: 2,
    timeout_after_position: 5,
    block_enabled: false,
    block_only: false,
    dca_enabled: false,
    dca_only: true,
    auto_evaluate: true,
    evaluation_interval_hours: 1,
    is_active: true,
  },
]

export async function seedDefaultPresetTypes(): Promise<void> {
  try {
    await initRedis()
    const client = getRedisClient()

    // Check if preset types already exist
    const existingKeys = await (client as any).keys("preset_type:*")
    if (existingKeys && existingKeys.length > 0) {
      console.log("[v0] Preset types already exist, skipping seeding")
      return
    }

    console.log("[v0] Seeding default preset types...")

    for (const presetData of DEFAULT_PRESET_TYPES) {
      const id = nanoid()
      const presetType = {
        id,
        ...presetData,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      const key = `preset_type:${id}`
      await (client as any).hset(key, presetType)
      console.log("[v0] Seeded preset type:", presetType.name)
    }

    console.log("[v0] Successfully seeded", DEFAULT_PRESET_TYPES.length, "default preset types")
  } catch (error) {
    console.error("[v0] Failed to seed preset types:", error)
  }
}
