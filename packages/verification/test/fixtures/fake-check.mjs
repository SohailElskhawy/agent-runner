const delayMs = Number(process.env.FAKE_CHECK_DELAY_MS ?? "0");
if (delayMs > 0) {
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
process.stdout.write(
  JSON.stringify({
    cwd: process.cwd(),
    argv: process.argv.slice(2),
    marker: process.env.FAKE_CHECK_MARKER ?? "",
  }),
);
process.stderr.write(process.env.FAKE_CHECK_STDERR ?? "");
process.exit(Number(process.env.FAKE_CHECK_EXIT ?? "0"));
