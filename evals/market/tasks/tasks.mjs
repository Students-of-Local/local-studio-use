// The shared task set. Each task: a start path, the goal a person would give an agent, and a check that reads
// what the page itself posted to the site (or, for a read task, the agent's answer). A check can fail.
export const tasks = [
	{
		id: "t01-read",
		start: "/t01-read/",
		goal: "Open the page and report the battery capacity of the K7 model in mAh. Answer with the number only.",
		check: ({ answer }) => ({ pass: /\b4870\b/.test(answer ?? "") && !/\b3900\b/.test(answer ?? ""), why: `answer=${JSON.stringify(answer)}` }),
	},
	{
		id: "t02-form",
		start: "/t02-form/",
		goal: "Create an account with full name Ada Lovelace, email ada@example.test, the Team plan, preferred contact Phone, and the monthly newsletter turned on. Then submit the form.",
		check: ({ state: s }) => ({
			pass: !!s && s.name === "Ada Lovelace" && s.email === "ada@example.test" && s.plan === "team" && s.contact === "phone" && s.news === true,
			why: JSON.stringify(s),
		}),
	},
	{
		id: "t03-multitab",
		start: "/t03-multitab/",
		goal: "The voucher code is on the voucher page, which opens in a new tab. Get the code and redeem it on the first page.",
		check: ({ state: s, site }) => ({ pass: !!s && s.code === site.secret("voucher"), why: `${JSON.stringify(s)} want ${site.secret("voucher")}` }),
	},
	{
		id: "t04-checkout",
		start: "/t04-checkout/?new",
		goal: "Buy 2 Blue Mugs and 1 Tea Tin. Check out with name Grace Hopper, street address 1 Navy Way, ZIP code 20001 and Express shipping, then place the order.",
		check: ({ state: s }) => ({
			pass:
				!!s &&
				s.name === "Grace Hopper" &&
				s.address === "1 Navy Way" &&
				s.zip === "20001" &&
				s.ship === "express" &&
				(s.cart?.mug ?? 0) === 2 &&
				(s.cart?.tin ?? 0) === 1 &&
				(s.cart?.pot ?? 0) === 0,
			why: JSON.stringify(s),
		}),
	},
	{
		id: "t05-iframe",
		start: "/t05-iframe/",
		goal: "Pay the invoice: in the payment form, enter Alan Turing as the card holder and confirm the payment.",
		check: ({ state: s }) => ({ pass: !!s && s.holder === "Alan Turing", why: JSON.stringify(s) }),
	},
	{
		id: "t06-shadow",
		start: "/t06-shadow/",
		goal: "Change the display name to Kestrel and save it.",
		check: ({ state: s }) => ({ pass: !!s && s.displayName === "Kestrel", why: JSON.stringify(s) }),
	},
	{
		id: "t07-upload",
		start: "/t07-upload/",
		goal: "Attach the receipt file at {{fixtures}}/receipt.txt to the expense claim and submit the claim.",
		check: ({ state: s }) => ({ pass: !!s && s.name === "receipt.txt" && s.firstLine === "RECEIPT-0091", why: JSON.stringify(s) }),
	},
	{
		id: "t08-stale",
		start: "/t08-stale/",
		goal: "Click Refresh list, then approve invoice 3307 and no other invoice.",
		check: ({ state: s }) => ({ pass: !!s && s.approved.length === 1 && s.approved[0] === "3307", why: JSON.stringify(s) }),
	},
	{
		id: "t09-long",
		start: "/t09-long/",
		goal: "Find the current access phrase in the field manual on this page and enter it in the Access phrase box at the top, then press Unlock.",
		check: ({ state: s, site }) => ({ pass: !!s && s.phrase === site.secret("phrase"), why: `${JSON.stringify(s)} want ${site.secret("phrase")}` }),
	},
	{
		id: "t10-dialog",
		start: "/t10-dialog/",
		goal: "Delete the draft named Q3 plan. Accept the confirmation, and when asked, type DELETE.",
		check: ({ state: s }) => ({ pass: !!s && s.deleted === true && s.typed === "DELETE", why: JSON.stringify(s) }),
	},
];
