process.stdout.write("started\n");
const ms = Number(process.argv[2] ?? "60000");
setTimeout(() => process.exit(0), ms);
