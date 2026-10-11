// Sets a maximum on the module's linear memory: `cap-memory.mjs <in.wasm> <out.wasm> <max MiB>`.
// Go's linker declares none, which leaves the limit to the engine. build.sh pins it to the wasm32
// ceiling; the limit scripts actually meet is the lower one that worker.mjs enforces.

import { readFileSync, writeFileSync } from "node:fs";

const [input, output, maxMiB] = process.argv.slice(2);
const PAGE = 64 * 1024;
const MEMORY_SECTION = 5;
const bytes = readFileSync(input);

function readLeb(at) {
	let value = 0;
	let shift = 0;
	let byte;
	do {
		byte = bytes[at++];
		value += (byte & 0x7f) * 2 ** shift;
		shift += 7;
	} while (byte & 0x80);
	return { value, next: at };
}

function leb(value) {
	const out = [];
	do {
		const byte = value % 128;
		value = Math.floor(value / 128);
		out.push(value > 0 ? byte | 0x80 : byte);
	} while (value > 0);
	return out;
}

let at = 8;
while (at < bytes.length) {
	const id = bytes[at];
	const size = readLeb(at + 1);
	if (id !== MEMORY_SECTION) {
		at = size.next + size.value;
		continue;
	}
	const count = readLeb(size.next);
	const flags = readLeb(count.next);
	const min = readLeb(flags.next);
	if (count.value !== 1 || (flags.value & ~1) !== 0) {
		throw new Error(`Unexpected memory section: ${count.value} memories, flags ${flags.value}`);
	}
	const max = Math.floor((Number(maxMiB) * 1024 * 1024) / PAGE);
	if (!(max >= min.value)) throw new Error(`Maximum of ${max} pages is below the initial ${min.value}`);
	const payload = [1, 1, ...leb(min.value), ...leb(max)];
	writeFileSync(
		output,
		Buffer.concat([
			bytes.subarray(0, at),
			Buffer.from([MEMORY_SECTION, ...leb(payload.length), ...payload]),
			bytes.subarray(size.next + size.value),
		]),
	);
	console.log(`memory: initial ${(min.value * PAGE) / 2 ** 20} MiB, maximum ${(max * PAGE) / 2 ** 20} MiB`);
	process.exit(0);
}
throw new Error("No memory section found");
