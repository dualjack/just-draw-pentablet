<script lang="ts">
	import { onDestroy } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';

	type ConnectionState = 'idle' | 'connecting' | 'connected' | 'closed' | 'error';
	type PointerPhase = 'down' | 'move' | 'up' | 'cancel';

	type PointerSample = {
		type: 'pointer';
		seq: number;
		phase: PointerPhase;
		pointerId: number;
		pointerType: string;
		x: number;
		y: number;
		nx: number;
		ny: number;
		pressure: number;
		tiltX: number;
		tiltY: number;
		twist: number;
		width: number;
		height: number;
		buttons: number;
		clientNow: number;
		clientWallTime: number;
	};

	type LastSample = Pick<
		PointerSample,
		'phase' | 'pointerType' | 'x' | 'y' | 'pressure' | 'tiltX' | 'tiltY' | 'buttons'
	>;

	const receiverPort = 8787;

	let socket: WebSocket | null = null;
	let seq = 0;
	let sentSinceTick = 0;
	let receivedAcksSinceTick = 0;
	let pendingAcks = new SvelteMap<number, number>();
	let tickTimer: ReturnType<typeof setInterval> | null = null;

	let serverUrl = $state(defaultServerUrl());
	let connectionState = $state<ConnectionState>('idle');
	let lastError = $state('');
	let showHud = $state(true);
	let lastSample = $state<LastSample | null>(null);
	let stats = $state({
		sentTotal: 0,
		sentPerSecond: 0,
		acksPerSecond: 0,
		pending: 0,
		lastRttMs: 0,
		bestRttMs: 0
	});

	let connectionLabel = $derived(
		connectionState === 'connected'
			? 'connected'
			: connectionState === 'connecting'
				? 'connecting'
				: connectionState
	);
	let inputLabel = $derived(
		lastSample?.pointerType === 'pen'
			? 'Apple Pencil / pen'
			: lastSample?.pointerType === 'touch'
				? 'finger / touch'
				: (lastSample?.pointerType ?? 'waiting for input')
	);
	let pressurePercent = $derived(Math.round((lastSample?.pressure ?? 0) * 100));

	function defaultServerUrl() {
		if (typeof localStorage !== 'undefined') {
			const saved = localStorage.getItem('receiverUrl');
			if (saved) return saved;
		}

		const host = typeof location !== 'undefined' ? location.hostname : 'localhost';
		return `ws://${host}:${receiverPort}`;
	}

	function connect() {
		disconnect();
		lastError = '';
		connectionState = 'connecting';

		try {
			socket = new WebSocket(serverUrl);
		} catch (error) {
			connectionState = 'error';
			lastError = error instanceof Error ? error.message : 'Could not create WebSocket';
			return;
		}

		socket.addEventListener('open', () => {
			connectionState = 'connected';
			localStorage.setItem('receiverUrl', serverUrl);
			sendControl('hello');
			startStatsTimer();
		});

		socket.addEventListener('message', (event) => {
			handleReceiverMessage(event.data);
		});

		socket.addEventListener('close', () => {
			connectionState = 'closed';
			stopStatsTimer();
		});

		socket.addEventListener('error', () => {
			connectionState = 'error';
			lastError = 'WebSocket connection failed';
			stopStatsTimer();
		});
	}

	function disconnect() {
		if (socket) {
			socket.close();
			socket = null;
		}

		stopStatsTimer();
		pendingAcks.clear();
		stats.pending = 0;
	}

	function handleReceiverMessage(data: unknown) {
		if (typeof data !== 'string') return;

		try {
			const message = JSON.parse(data) as { type?: string; seq?: number };
			if (message.type !== 'ack' || typeof message.seq !== 'number') return;

			const sentAt = pendingAcks.get(message.seq);
			if (sentAt === undefined) return;

			pendingAcks.delete(message.seq);
			receivedAcksSinceTick += 1;

			const rtt = performance.now() - sentAt;
			stats.lastRttMs = rtt;
			stats.bestRttMs = stats.bestRttMs === 0 ? rtt : Math.min(stats.bestRttMs, rtt);
			stats.pending = pendingAcks.size;
		} catch {
			// Ignore non-MVP messages from experimental receivers.
		}
	}

	function sendControl(action: string) {
		if (!socket || socket.readyState !== WebSocket.OPEN) return;

		socket.send(
			JSON.stringify({
				type: 'control',
				action,
				clientNow: performance.now(),
				clientWallTime: Date.now()
			})
		);
	}

	function handlePointer(event: PointerEvent, phase: PointerPhase) {
		event.preventDefault();
		const surface = event.currentTarget as HTMLDivElement;

		if (phase === 'down') {
			surface.setPointerCapture(event.pointerId);
		}

		const events =
			phase === 'move' && typeof event.getCoalescedEvents === 'function'
				? event.getCoalescedEvents()
				: [event];

		for (const sample of events) {
			sendPointerSample(surface, sample, phase);
		}

		if ((phase === 'up' || phase === 'cancel') && surface.hasPointerCapture(event.pointerId)) {
			surface.releasePointerCapture(event.pointerId);
		}
	}

	function sendPointerSample(surface: HTMLDivElement, event: PointerEvent, phase: PointerPhase) {
		const rect = surface.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const y = event.clientY - rect.top;
		const sampleSeq = ++seq;
		const now = performance.now();

		const sample: PointerSample = {
			type: 'pointer',
			seq: sampleSeq,
			phase,
			pointerId: event.pointerId,
			pointerType: event.pointerType,
			x,
			y,
			nx: clamp(x / rect.width, 0, 1),
			ny: clamp(y / rect.height, 0, 1),
			pressure: event.pressure,
			tiltX: event.tiltX,
			tiltY: event.tiltY,
			twist: event.twist,
			width: rect.width,
			height: rect.height,
			buttons: event.buttons,
			clientNow: now,
			clientWallTime: Date.now()
		};

		lastSample = {
			phase: sample.phase,
			pointerType: sample.pointerType,
			x: sample.x,
			y: sample.y,
			pressure: sample.pressure,
			tiltX: sample.tiltX,
			tiltY: sample.tiltY,
			buttons: sample.buttons
		};

		if (!socket || socket.readyState !== WebSocket.OPEN) return;

		pendingAcks.set(sampleSeq, now);
		socket.send(JSON.stringify(sample));

		stats.sentTotal += 1;
		stats.pending = pendingAcks.size;
		sentSinceTick += 1;
	}

	function startStatsTimer() {
		stopStatsTimer();
		tickTimer = setInterval(() => {
			stats.sentPerSecond = sentSinceTick * 4;
			stats.acksPerSecond = receivedAcksSinceTick * 4;
			stats.pending = pendingAcks.size;
			sentSinceTick = 0;
			receivedAcksSinceTick = 0;
		}, 250);
	}

	function stopStatsTimer() {
		if (tickTimer) {
			clearInterval(tickTimer);
			tickTimer = null;
		}
	}

	function clamp(value: number, min: number, max: number) {
		return Math.min(max, Math.max(min, value));
	}

	async function enterFullscreen() {
		await document.documentElement.requestFullscreen?.();
	}

	onDestroy(disconnect);
</script>

<svelte:head>
	<title>iPad Pen Tablet MVP</title>
</svelte:head>

<div
	class="pad"
	role="application"
	aria-label="Pen tablet input surface"
	onpointerdown={(event) => handlePointer(event, 'down')}
	onpointermove={(event) => handlePointer(event, 'move')}
	onpointerup={(event) => handlePointer(event, 'up')}
	onpointercancel={(event) => handlePointer(event, 'cancel')}
	oncontextmenu={(event) => event.preventDefault()}
>
	{#if showHud}
		<section class="hud" aria-label="Connection controls">
			<div class="title">
				<span>iPad Pen Tablet MVP</span>
				<span class:connected={connectionState === 'connected'}>{connectionLabel}</span>
			</div>

			<label>
				Receiver WebSocket URL
				<input bind:value={serverUrl} autocapitalize="none" autocomplete="off" spellcheck="false" />
			</label>

			<div class="actions">
				<button onclick={connect}>Connect</button>
				<button onclick={disconnect}>Disconnect</button>
				<button onclick={enterFullscreen}>Fullscreen</button>
				<button onclick={() => (showHud = false)}>Hide HUD</button>
			</div>

			<div class="stats">
				<span>sent {stats.sentPerSecond}/s</span>
				<span>acks {stats.acksPerSecond}/s</span>
				<span>pending {stats.pending}</span>
				<span>rtt {stats.lastRttMs.toFixed(1)} ms</span>
				<span>best {stats.bestRttMs.toFixed(1)} ms</span>
				<span>total {stats.sentTotal}</span>
			</div>

			{#if lastSample}
				<div class="sample">
					<span>{inputLabel} {lastSample.phase}</span>
					<span>x {lastSample.x.toFixed(1)}</span>
					<span>y {lastSample.y.toFixed(1)}</span>
					<span>p {lastSample.pressure.toFixed(3)}</span>
					<span>tilt {lastSample.tiltX}/{lastSample.tiltY}</span>
					<span>buttons {lastSample.buttons}</span>
				</div>

				<div class="pressure" style:--pressure={pressurePercent + '%'}>
					<span>pressure {pressurePercent}%</span>
				</div>
			{/if}

			{#if lastError}
				<p class="error">{lastError}</p>
			{/if}
		</section>
	{:else}
		<button class="show-hud" onclick={() => (showHud = true)}>Show HUD</button>
	{/if}
</div>

<style>
	:global(html, body) {
		margin: 0;
		width: 100%;
		height: 100%;
		overflow: hidden;
		background: #050505;
		color: #f5f5f5;
		font-family:
			Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
	}

	:global(*) {
		box-sizing: border-box;
		-webkit-tap-highlight-color: transparent;
	}

	.pad {
		position: fixed;
		inset: 0;
		background:
			radial-gradient(circle at center, rgb(22 22 22 / 80%), transparent 42rem),
			#050505;
		cursor: crosshair;
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
	}

	.hud,
	.show-hud {
		position: fixed;
		left: max(1rem, env(safe-area-inset-left));
		top: max(1rem, env(safe-area-inset-top));
		border: 1px solid rgb(255 255 255 / 15%);
		border-radius: 1rem;
		background: rgb(12 12 12 / 86%);
		backdrop-filter: blur(16px);
		box-shadow: 0 1rem 4rem rgb(0 0 0 / 45%);
	}

	.hud {
		display: grid;
		width: min(36rem, calc(100vw - 2rem));
		gap: 0.8rem;
		padding: 1rem;
	}

	.title,
	.stats,
	.sample,
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
	}

	.title {
		justify-content: space-between;
		font-weight: 700;
	}

	.title span:last-child,
	.stats span,
	.sample span {
		border-radius: 999px;
		background: rgb(255 255 255 / 9%);
		padding: 0.25rem 0.55rem;
		font-size: 0.82rem;
	}

	.pressure {
		position: relative;
		overflow: hidden;
		border-radius: 999px;
		background: rgb(255 255 255 / 9%);
		padding: 0.35rem 0.6rem;
		font-size: 0.82rem;
	}

	.pressure::before {
		position: absolute;
		inset: 0;
		width: var(--pressure);
		background: rgb(59 130 246 / 75%);
		content: "";
	}

	.pressure span {
		position: relative;
	}

	.title span:last-child.connected {
		background: rgb(21 128 61 / 90%);
	}

	label {
		display: grid;
		gap: 0.35rem;
		font-size: 0.82rem;
		color: #cfcfcf;
	}

	input {
		width: 100%;
		border: 1px solid rgb(255 255 255 / 18%);
		border-radius: 0.7rem;
		background: rgb(255 255 255 / 9%);
		color: #fff;
		font: inherit;
		padding: 0.7rem 0.8rem;
	}

	button {
		border: 0;
		border-radius: 999px;
		background: #f5f5f5;
		color: #050505;
		font: inherit;
		font-weight: 700;
		padding: 0.62rem 0.85rem;
	}

	.error {
		margin: 0;
		color: #fecaca;
	}

	.show-hud {
		color: #f5f5f5;
		padding: 0.7rem 0.9rem;
	}
</style>
