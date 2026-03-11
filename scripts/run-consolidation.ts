#!/usr/bin/env -S deno run -A
/**
 * Run catch-up consolidation for missing weeks
 */

import { DBClient } from "../src/db/mod.ts";
import { runAllConsolidations } from "../src/memory/consolidator.ts";

const projectRoot = Deno.cwd();
const db = new DBClient(".psycheros/psycheros.db");

console.log("=== Running Catch-up Consolidation ===\n");

const results = await runAllConsolidations(db, projectRoot);

console.log("\n=== Consolidation Results ===");
for (const result of results) {
  if (result.success) {
    console.log(`SUCCESS: ${result.memoryFile?.path}`);
    console.log(`  Chat IDs: ${result.memoryFile?.chatIds.length}`);
  } else {
    console.log(`FAILED: ${result.error}`);
  }
}

if (results.length === 0) {
  console.log("No consolidations needed.");
}

db.close();
