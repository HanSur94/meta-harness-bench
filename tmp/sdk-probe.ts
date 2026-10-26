import Anthropic from "@anthropic-ai/sdk";
console.log("baseURL env:", process.env.ANTHROPIC_BASE_URL);
const c = new Anthropic({ authToken: process.env.ANTHROPIC_AUTH_TOKEN });
const t0 = Date.now();
try {
	const r = await c.messages.create({
		model: "kimi-k3.1-pro",
		max_tokens: 32,
		messages: [{ role: "user", content: "Reply with: ready" }],
	});
	console.log("ok", Date.now() - t0, "ms", JSON.stringify(r).slice(0, 300));
} catch (e) {
	console.log("ERR", Date.now() - t0, "ms", (e as Error).message.slice(0, 400));
}
