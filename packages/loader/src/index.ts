#!/usr/bin/env node
import { Command } from "commander";
import { runPipeline } from "./pipeline.js";
import { runPlaceUI } from "./geo/placeUI.js";

const program = new Command();
program
  .name("gc-loader")
  .description("Ingest photos/videos into the Grand Canyon trip map.");

program
  .command("run")
  .description("Ingest, geolocate, analyze, upload, and update the manifest.")
  .option("-s, --source <source>", "local | google | all", "all")
  .option("-d, --dir <dir>", "folder to ingest (for --source local)")
  .option("-c, --credit <name>", "contributor credit for these assets")
  .option("--force", "reprocess assets even if already in state")
  .option("--no-ai", "skip Claude analysis (dry run)")
  .action(async (opts) => {
    await runPipeline({
      source: opts.source,
      dir: opts.dir,
      credit: opts.credit,
      force: opts.force,
      noAi: !opts.ai,
    });
  });

program
  .command("place")
  .description("Open the local UI to drag un-geolocated assets onto the map.")
  .option("-p, --port <port>", "port", "4321")
  .action(async (opts) => {
    await runPlaceUI(Number(opts.port));
  });

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
