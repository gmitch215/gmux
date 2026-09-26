const status = document.getElementById('status');
const tokenInput = document.getElementById('token');
const connectButton = document.getElementById('connect');
const claimButton = document.getElementById('claim');
const term = new Terminal({ convertEol: true, cursorBlink: true });
term.open(document.getElementById('term'));

const socketUrl = (kind, token) => {
	const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
	return `${scheme}://${location.host}/_gmux/term/ws?kind=${kind}&token=${encodeURIComponent(token)}`;
};
const readToken = () => {
	try {
		return localStorage.getItem('gmux-token');
	} catch {
		return null;
	}
};
const saveToken = (token) => {
	try {
		localStorage.setItem('gmux-token', token);
	} catch {}
};

let warm = null;
let ticker = null;

function openWarm(token) {
	if (warm) return;
	warm = new WebSocket(socketUrl('warm', token));
	warm.onopen = () =>
		(ticker = setInterval(() => warm.readyState === 1 && warm.send('tick'), 1000));
	warm.onclose = () => {
		clearInterval(ticker);
		warm = null;
	};
}

function closeWarm() {
	clearInterval(ticker);
	warm?.close();
	warm = null;
}

function connect(token) {
	const control = new WebSocket(socketUrl('control', token));
	control.onopen = () => {
		status.textContent = 'Connected';
		tokenInput.hidden = connectButton.hidden = true;
		control.send(JSON.stringify({ t: 'in', d: '\n' }));
		openWarm(token);
	};
	control.onmessage = (event) => {
		const msg = JSON.parse(event.data);
		if (msg.t === 'out') term.write(msg.d);
		if (msg.t === 'status') status.textContent = `Machine ${msg.d}`;
	};
	control.onclose = (event) => {
		status.textContent = event.code === 1006 ? 'Disconnected' : 'Closed';
		closeWarm();
	};
	term.onData(
		(data) => control.readyState === 1 && control.send(JSON.stringify({ t: 'in', d: data }))
	);
	// a hidden page stops holding the machine resident
	document.addEventListener('visibilitychange', () =>
		document.hidden ? closeWarm() : openWarm(token)
	);
}

async function start() {
	let res;
	while ((res = await fetch('/_gmux/status')).status === 503) {
		status.textContent = 'Placing the Machine';
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	const machine = await res.json();
	const token = readToken();
	if (token) return connect(token);
	if (!machine.claimed) {
		status.textContent = 'Unclaimed; the first visitor to claim it owns it';
		claimButton.hidden = false;
		claimButton.onclick = async () => {
			const res = await (await fetch('/_gmux/claim', { method: 'POST' })).json();
			if (!res.token) return (status.textContent = 'Already Claimed');
			saveToken(res.token);
			claimButton.hidden = true;
			term.write(`Owner token (shown once; keep it): ${res.token}\r\n`);
			connect(res.token);
		};
		return;
	}
	status.textContent = 'Owner Token Required';
	tokenInput.hidden = connectButton.hidden = false;
	connectButton.onclick = () => {
		saveToken(tokenInput.value);
		connect(tokenInput.value);
	};
}

start();
