import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

// Surface any crash with a clear, labeled message instead of a bare exit code 1.
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err?.stack || err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error("[FATAL] Unhandled rejection:", err?.stack || err);
  process.exit(1);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express(
