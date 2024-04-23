const dateFormat = require("dateformat");
const Koa = require("koa");
const route = require("koa-route");
const websockify = require("koa-websocket");
const ivm = require("isolated-vm");

const VERSION = "0.0.3";
const MOD_NAME = `screepsmod-inspector@${VERSION}`;

// Check to see if this is `runner.js`
let runnerEndpoint;
for (let ii = 0; ii < process.argv.length; ++ii) {
	if (process.argv[ii].includes("runner.js")) {
		console.log(`[${MOD_NAME}] found runnerEndpoint`);
		runnerEndpoint = true;
		break;
	}
}

// Start inspector endpoint
const playerSandboxes = new Map();
function listen() {
	console.log(`[${MOD_NAME}] in listen`);
	const app = websockify(new Koa());
	app.use(
		route.get("/", (ctx) => {
			console.log(`[${MOD_NAME}] get /`);
			ctx.body = `<!doctype html>
<head>
	<title>isolated-vm inspector list</title>
</head>
<body>
	<p>I can't hyperlink to the chrome devtools so you have to click the textbox, copy it, and paste into a new window.</p>
	<table>
		<tr>
			<th>User</th>
			<th>Created</th>
			<th>isolate.cpuTime</th>
			<th>Inspector</th>
		</tr>
${(() => {
	const rows = [];
	for (const pair of playerSandboxes) {
		const uri = `devtools://devtools/bundled/inspector.html?experiments=true&v8only=true&ws=127.0.0.1:7777/inspect/${pair[0]}`;
		const cpuTime = pair[1].getIsolate().cpuTime;
		rows.push(`<tr>
			<td>${pair[0]}</td>
			<td>${dateFormat(pair[1]._created, "hh:MM.sstt")}</td>
			<td>${cpuTime[0] * 1e3 + cpuTime[1] / 1e6}ms</td>
			<td><input type="text" readonly value="${uri}" onclick="this.select()" width=100 /></td>
		</tr>`);
	}
	return rows.join("");
})()}
</table></html>
		`;
		}),
	);
	app.ws.use(async (ctx, next) => {
		try {
			console.log(`[${MOD_NAME}] await next`);
			await next();
		} catch (err) {
			console.error("inspector error", err);
			ctx.websocket.close();
		}
	});
	app.ws.use(
		route.all("/inspect/:userId", async (ctx) => {
			const userId = /\/inspect\/(.+)/.exec(ctx.req.url)[1]; // koa-route is broken?
			console.log(`[${MOD_NAME}] ws /inspect/:userId`, userId);
			const sandbox = playerSandboxes.get(userId);
			const ws = ctx.websocket;

			if (sandbox === undefined) {
				ctx.websocket.close();
				return;
			}

			// Setup inspector session
			const channel = sandbox.getIsolate().createInspectorSession();
			function dispose() {
				console.log(`[${MOD_NAME}] dispose`);
				try {
					channel.dispose();
				} catch (err) {}
			}
			ws.on("error", dispose);
			ws.on("close", dispose);

			// Relay messages from frontend to backend
			ws.on("message", (message) => {
				console.log(`[${MOD_NAME}] got ws message:`, message);
				try {
					channel.dispatchProtocolMessage(message);
				} catch (err) {
					// This happens if inspector session was closed unexpectedly
					dispose();
					ws.close();
				}
			});

			// Relay messages from backend to frontend
			function send(message) {
				console.log(`[${MOD_NAME}] send ws message:`, message);
				try {
					ws.send(message);
				} catch (err) {
					dispose();
				}
			}
			channel.onResponse = (callId, message) => send(message);
			channel.onNotification = send;
		}),
	);
	app.ws.use((ctx) => {
		console.log(`[${MOD_NAME}] ws will close`);
		ctx.websocket.close();
	});
	console.log(`[${MOD_NAME}] Listening on port 7777`);
	app.listen(7777);
}

// Include `print` function in every isolate which goes to main nodejs output
ivm.Isolate.prototype.createContext = ((createContext) =>
	async function (...args) {
		console.log(`[${MOD_NAME}] ivm createContext`);
		const context = await createContext.apply(this, args);
		await context.global.set(
			"print",
			new ivm.Reference((...args) => console.log(...args)),
		);
		await (
			await this.compileScript(
				'print = (print => (...args) => print.applySync(null, args.map(str => "" + str)))(print)',
			)
		).run(context);
		return context;
	})(ivm.Isolate.prototype.createContext);

// Screeps mod
module.exports = (config) => {
	if (!config.engine) {
		console.log(`[${MOD_NAME}] No engine detected, exiting...`);
		return;
	}
	config.engine.enableInspector = true;
	config.engine.mainLoopResetInterval = 0x7fffffff;
	if (runnerEndpoint) {
		console.log(`[${MOD_NAME}] Found runner endpoint. Listening...`);
		listen();
		config.engine.on("playerSandbox", (sandbox, userId) => {
			console.log(`[${MOD_NAME}] on playerSandbox`);
			const current = playerSandboxes.get(userId);
			if (
				current !== undefined &&
				current.getIsolate() === sandbox.getIsolate()
			) {
				sandbox._created = current._created;
			} else {
				sandbox._created = Date.now();
			}
			playerSandboxes.set(userId, sandbox);
		});
	}
};
