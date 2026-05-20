import os from 'node:os';
import process from 'node:process';
import { WebSocketServer } from 'ws';

const port = Number(process.env.PORT ?? 8787);
const mouseEnabled = process.env.MOUSE === '1' || process.argv.includes('--mouse');
const pencilMode = process.env.PENCIL === '1' || process.argv.includes('--pencil');
const pointerFilter = process.env.POINTER ?? (pencilMode ? 'pen' : 'any');
const pressureThreshold = Number(process.env.PRESSURE_THRESHOLD ?? 0.08);
const wss = new WebSocketServer({ port });

const clients = new Map();
const robot = await loadRobot();
let mouseDown = false;
let applyBusy = false;

function localAddresses() {
	try {
		return Object.values(os.networkInterfaces())
			.flat()
			.filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
			.map((entry) => entry.address);
	} catch (error) {
		console.warn('[network] could not list LAN addresses');
		console.warn(error instanceof Error ? error.message : error);
		return [];
	}
}

function createClientState() {
	return {
		connectedAt: Date.now(),
		total: 0,
		pointer: 0,
		control: 0,
		lastSeq: 0,
		lastPointer: null,
		receivedThisSecond: 0,
		droppedEstimate: 0
	};
}

async function loadRobot() {
	if (!mouseEnabled) return null;

	try {
		const { mouse, screen, Button } = await import('@nut-tree-fork/nut-js');
		mouse.config.autoDelayMs = 0;
		mouse.config.mouseSpeed = 9999;

		const screenWidth = await screen.width();
		const screenHeight = await screen.height();

		return { mouse, Button, screenWidth, screenHeight };
	} catch (error) {
		console.error('[mouse] nut-js could not be loaded, mouse control disabled');
		console.error(error instanceof Error ? error.message : error);
		return null;
	}
}

function applyMouseInput(sample) {
	if (!robot || !shouldUsePointer(sample)) return;
	if (applyBusy) return;

	applyBusy = true;

	const { mouse, Button, screenWidth, screenHeight } = robot;
	const x = clamp(Math.round(sample.nx * (screenWidth - 1)), 0, screenWidth - 1);
	const y = clamp(Math.round(sample.ny * (screenHeight - 1)), 0, screenHeight - 1);

	let p = mouse.setPosition({ x, y });

	if (pencilMode) {
		const isPressed =
			sample.phase !== 'up' &&
			sample.phase !== 'cancel' &&
			Number(sample.pressure) >= pressureThreshold;
		if (isPressed !== mouseDown) {
			p = p.then(() =>
				isPressed ? mouse.pressButton(Button.LEFT) : mouse.releaseButton(Button.LEFT)
			);
			mouseDown = isPressed;
		}
	} else {
		if (sample.phase === 'down' && !mouseDown) {
			p = p.then(() => mouse.pressButton(Button.LEFT));
			mouseDown = true;
		} else if ((sample.phase === 'up' || sample.phase === 'cancel') && mouseDown) {
			p = p.then(() => mouse.releaseButton(Button.LEFT));
			mouseDown = false;
		}
	}

	p.catch((err) => console.error('[mouse] error:', err instanceof Error ? err.message : err)).finally(
		() => {
			applyBusy = false;
		}
	);
}

function shouldUsePointer(sample) {
	if (pointerFilter !== 'any' && sample.pointerType !== pointerFilter) return false;
	return Number.isFinite(sample.nx) && Number.isFinite(sample.ny);
}

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

wss.on('connection', (ws, request) => {
	const state = createClientState();
	clients.set(ws, state);

	console.log(`[connect] ${request.socket.remoteAddress}`);

	ws.on('message', (raw) => {
		state.total += 1;
		state.receivedThisSecond += 1;

		let message;
		try {
			message = JSON.parse(raw.toString());
		} catch {
			console.warn('[warn] ignored invalid JSON message');
			return;
		}

		if (message.type === 'control') {
			state.control += 1;
			console.log(`[control] ${message.action ?? 'unknown'}`);
			return;
		}

		if (message.type !== 'pointer') return;

		state.pointer += 1;
		state.lastPointer = message;
		applyMouseInput(message);

		if (typeof message.seq === 'number') {
			if (state.lastSeq && message.seq > state.lastSeq + 1) {
				state.droppedEstimate += message.seq - state.lastSeq - 1;
			}
			state.lastSeq = message.seq;

			if (ws.readyState === ws.OPEN) {
				ws.send(
					JSON.stringify({
						type: 'ack',
						seq: message.seq,
						serverWallTime: Date.now()
					})
				);
			}
		}
	});

	ws.on('close', () => {
		clients.delete(ws);
		if (robot && mouseDown) {
			robot.mouse.releaseButton(robot.Button.LEFT).catch(() => {});
			mouseDown = false;
		}
		console.log('[disconnect]');
	});
});

setInterval(() => {
	for (const state of clients.values()) {
		const sample = state.lastPointer;
		const pointerInfo = sample
			? `${sample.pointerType}:${sample.phase} x=${sample.x.toFixed(1)} y=${sample.y.toFixed(
					1
				)} p=${sample.pressure.toFixed(3)} tilt=${sample.tiltX}/${sample.tiltY}`
			: 'no pointer data yet';

		console.log(
			`[stats] ${state.receivedThisSecond}/s total=${state.total} pointer=${state.pointer} dropped~=${state.droppedEstimate} ${pointerInfo}`
		);

		state.receivedThisSecond = 0;
	}
}, 1000);

console.log(`iPad Pen Tablet MVP receiver listening on ws://0.0.0.0:${port}`);
console.log(
	`[mouse] ${robot ? 'enabled' : 'disabled'}${mouseEnabled && !robot ? ' (nut-js unavailable)' : ''}`
);
console.log(
	`[input] pointer=${pointerFilter} pencilMode=${pencilMode ? 'enabled' : 'disabled'} pressureThreshold=${pressureThreshold}`
);
for (const address of localAddresses()) {
	console.log(`LAN URL: ws://${address}:${port}`);
}
