process.stdout.write(
  JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    probe:
      process.env.PROCESS_RUNNER_PROBE === undefined
        ? null
        : process.env.PROCESS_RUNNER_PROBE,
    parentOnly:
      process.env.PROCESS_RUNNER_PARENT_ONLY === undefined
        ? null
        : process.env.PROCESS_RUNNER_PARENT_ONLY,
    pathPresent:
      process.env.PATH !== undefined || process.env.Path !== undefined,
  }),
);
process.stderr.write("stderr-marker");
