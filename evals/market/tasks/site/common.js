// Every task page reports what it changed here. The tool under test never needs this file.
window.report = (task, state) =>
	fetch("/__done", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task, ...state }) });
