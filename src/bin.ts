#!/usr/bin/env node
import { main } from "./cli/main.js";

main(process.argv).then((code) => {
  process.exitCode = code;
});
