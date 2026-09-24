import type { CliIo } from "../io.js";
import type { DoctorReport } from "../application/doctor.js";

export function renderDoctorReport(io: CliIo, report: DoctorReport): void {
  io.writeLine("agentic doctor: preflight checks");
  for (const check of report.checks) {
    io.writeLine(`[${check.status}] ${check.name} — ${check.detail}`);
  }
  io.writeLine(
    report.ok ? "doctor: all checks passed" : "doctor: one or more checks failed",
  );
}
