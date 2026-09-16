const version = process.env.FAKE_PROBE_VERSION ?? "fake-agent 1.0.0";
process.stdout.write(`${version}\n`);
process.exit(Number(process.env.FAKE_AGENT_EXIT_CODE ?? "0"));
