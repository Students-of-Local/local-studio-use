/**
 * Auto mode's rule list (docs/decisions.md, D67): which agent actions are risky enough to ask the person first, which
 * sites and apps are sensitive, and what no mode allows (password and payment entry). Pure and in one file, so every
 * surface reads the same rules: the extension's bridge, and computer use and VMs when they read the mode.
 *
 * Each rule has a test (test/risk-rules.test.mjs), and the list is scored on a labeled set of actions
 * (evals/market/risky-actions): recall on the risky ones is held at 100% by evals/market/floors.json.
 *
 * The rules read only what read_page shows (a control's role and name, the page's URL) plus a few attributes a page
 * can't hide from the extension (an input's type and autocomplete, a link's href, the form a control submits). A page
 * can name a Send button something else; Auto's asks are a net for an agent's mistakes, and Manual is the mode for a
 * person who wants every new site asked.
 */

/** What an action reaches, as the extension describes it before the action runs. */
export interface TargetFacts {
	/** The ARIA role read_page gives it ("button", "link", "textbox"). */
	role?: string;
	/** Its accessible name ("Send", "Delete repository"). */
	name?: string;
	/** An input's type attribute ("password", "submit"). */
	inputType?: string;
	/** An input's autocomplete attribute ("cc-number", "current-password"). */
	autocomplete?: string;
	/** A link's resolved href. */
	href?: string;
	/** The text of the dialog the control sits in, when it sits in one ("Delete 3 files? This can't be undone."). */
	dialog?: string;
	/** The form the control belongs to: the name of its submit button, and the URL it submits to. */
	form?: { submit?: string; action?: string };
	/** An input's name attribute, as words ("card number"). */
	field?: string;
	/** The URL of the frame the control is in, when that is not the page's own. */
	frameUrl?: string;
}

/** One agent action, before it runs. */
export interface ActionFacts {
	/** The bridge method: click, fill, type, press, navigate. */
	tool: string;
	/** The page the action is on; for navigate, the URL it opens. */
	url?: string;
	target?: TargetFacts;
	/** press: the key or chord ("Enter", "Meta+Enter"). */
	key?: string;
	/** type: true when it ends with Enter. */
	submit?: boolean;
	/** type and fill: the text, only so a hard limit can see that something is being entered. Never logged. */
	text?: string;
}

export type ActionRule = "send" | "post" | "pay" | "delete" | "account" | "oauth" | "run-file";
export type SiteClass = "mail" | "bank" | "passwords" | "cloud" | "government" | "health" | "account-pages";
export type AppClass = "keychain" | "system-settings" | "terminal" | "password-manager";
export type HardLimit = "password-field" | "payment-field";

export interface Verdict<R extends string> {
	rule: R;
	/** Why, in words the person reads in the question ("sends a message as you"). */
	why: string;
}

const squash = (t: string | undefined) => (t ?? "").toLowerCase().replace(/\s+/g, " ").trim();

function urlOf(raw: string | undefined): URL | undefined {
	if (!raw) return undefined;
	try {
		return new URL(raw);
	} catch {
		return undefined;
	}
}

const hostOf = (raw: string | undefined) => (urlOf(raw)?.hostname ?? "").toLowerCase().replace(/\.$/, "");

/** `host` is `domain` or a subdomain of it. */
const onDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

// ---- Action rules -------------------------------------------------------------------------------------------------

/** Roles a person commits with: a click on one does something. */
const COMMIT_ROLES = new Set(["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "option", ""]);
/** Roles that change a setting by themselves: risky on an account settings page. */
const TOGGLE_ROLES = new Set(["switch", "checkbox", "radio", "combobox", "listbox", "option"]);
/** Names that back out of something: never risky, whatever page they are on ("Cancel subscription" is not this). */
const BACK_OUT =
	/^(cancel|close|dismiss|back|go back|no|no,? thanks|not now|skip|later|maybe later|keep|stay|x|×|done reading)$/;
/** Names that only say yes to what the dialog or form around them says. */
const GENERIC_YES =
	/^(ok|okay|yes|confirm|continue|next|submit|save|save changes|apply|update|done|proceed|sure|go|enable|disable|turn on|turn off)$/;
/**
 * The verbs that make a dialog's yes risky ("Delete 3 files?", "Send this message?"). Narrower than the name rules:
 * a cookie banner's text says "share" and "manage", and its OK is not a risky action.
 */
const DIALOG_WORDS: ReadonlyArray<{ rule: ActionRule; why: string; words: RegExp }> = [
	{ rule: "send", why: "sends a message as you", words: /\b(send|reply|forward)\b/ },
	{ rule: "post", why: "posts or publishes as you", words: /\b(publish|post|tweet|go live)\b/ },
	{
		rule: "pay",
		why: "buys or pays with your account",
		words: /\b(pay|payment|purchase|buy|order|charge|charged|subscribe|subscription|transfer)\b/,
	},
	{
		rule: "delete",
		why: "deletes or cancels something of yours",
		words: /\b(delete|deleted|remove|erase|permanently|can'?t be undone|cannot be undone|unsubscribe|deactivate|close your account)\b/,
	},
	{
		rule: "account",
		why: "changes your account's settings or who can reach it",
		words: /\b(password|two-factor|2fa|make (it |this |the )?([a-z]+ )?(public|private)|revoke|transfer ownership|grant)\b/,
	},
];

/**
 * The action rules, in the order they are tried. Each reads a control's name (and for some the page's URL); the
 * first that matches is the reason the question gives.
 */
export const ACTION_RULES: ReadonlyArray<{ rule: ActionRule; why: string; words: RegExp }> = [
	{
		rule: "send",
		why: "sends a message as you",
		words: /\b(send|reply|reply all|forward|resend)\b/,
	},
	{
		rule: "post",
		why: "posts or publishes as you",
		words: /\b(post|publish|tweet|toot|repost|retweet|reblog|share|comment|go live|schedule post|submit (comment|review|answer|post|reply|feedback|application|form)|submit)\b/,
	},
	{
		rule: "pay",
		why: "buys or pays with your account",
		words: /\b(buy|buy now|purchase|pay|pay now|checkout|check out|place (your |my )?order|order now|subscribe|upgrade|donate|book now|book|reserve|rent|confirm (purchase|order|booking|payment|and pay)|complete (purchase|order|booking|payment)|start (my |your )?(free )?trial|add (a )?(card|payment method)|1-click|send money|transfer(?! (ownership|repository|domain|project))|withdraw|tip)\b/,
	},
	{
		rule: "delete",
		why: "deletes or cancels something of yours",
		words: /\b(delete|remove|erase|trash|destroy|discard|wipe|purge|empty (trash|bin)|permanently|unsubscribe|deactivate|close (my |your |this )?account|cancel (my |your |this )?(subscription|membership|plan|order|account|booking|reservation|payment)|leave (this )?(group|team|organization|org|server|workspace|channel)|uninstall|archive all|mark all as spam|report spam|block|unfollow|unfriend)\b/,
	},
	{
		rule: "account",
		why: "changes your account's settings or who can reach it",
		words: /\b((change|update|reset|set) (your |my )?(password|passcode|pin|email|e-mail|phone( number)?|username|recovery|security question|name)|two-factor|2fa|2-step|two-step|passkey|security key|make (it |this |the )?([a-z]+ )?(public|private)|change (role|permissions?|owner|visibility)|transfer (ownership|repository|domain|project)|add (a )?(member|collaborator|user|admin|owner|people|person|guest|delegate)|invite|grant|give access|manage access|share with|revoke|sign out (of )?(all|every|other)|log out (of )?(all|every|other)|disconnect|forwarding)\b/,
	},
	{
		rule: "oauth",
		why: "lets another app into your account",
		words: /\b(authorize|authorise|install app|grant access|allow access|connect (account|app))\b/,
	},
	{
		rule: "run-file",
		why: "downloads a program and runs it",
		words: /\b(download and (run|install|open)|run (this |the )?(file|installer|program|script|command)|run anyway|open installer|install now)\b/,
	},
];

/** A consent page: the place an OAuth grant is made. A yes there lets another app in. */
const OAUTH_PATH =
	/(^|\/)(oauth2?|authorize|authorise|consent|auth\/authorize|signin\/oauth|connect\/authorize)(\/|$|\?)/i;
const OAUTH_YES =
	/^(allow|authorize|authorise|accept|approve|grant|continue|install|connect|yes|confirm|agree|i agree|allow access|let'?s go)\b/;

/** A file that runs when it is opened: an installer, an app or a script. */
const RUNS_WHEN_OPENED =
	/\.(exe|msi|msix|appx|bat|cmd|com|scr|pif|ps1|vbs|vbe|wsf|hta|cpl|jar|dmg|pkg|mpkg|app|command|tool|sh|bash|zsh|run|bin|deb|rpm|appimage|apk|xapk|ipa|reg|lnk)$/i;

/** The account settings pages of the sites people sign in to, and the usual settings paths on any site. */
const SETTINGS_PATH =
	/^\/(settings|account|accounts|my-?account|security|preferences|privacy|profile\/edit|user\/settings|admin|manage|billing|subscriptions?|permissions|sharing|members|team\/settings|org\/settings|organizations\/[^/]+\/settings|[^/]+\/[^/]+\/settings)(\/|$)/i;

/** Hosts that are nothing but a person's account settings. */
const ACCOUNT_HOSTS = [
	"myaccount.google.com",
	"account.microsoft.com",
	"account.live.com",
	"mysignins.microsoft.com",
	"appleid.apple.com",
	"account.apple.com",
	"accounts.firefox.com",
	"account.proton.me",
];

/** Whether `url` is a page where a person changes their own account (its settings, security, billing). */
export function isAccountPage(url: string | undefined): boolean {
	const u = urlOf(url);
	if (!u) return false;
	const host = u.hostname.toLowerCase();
	if (ACCOUNT_HOSTS.some((d) => onDomain(host, d))) return true;
	return SETTINGS_PATH.test(u.pathname);
}

/** The keys that send what is in a field: Enter, and the chords chat and mail apps send with. */
const SENDS_FIELD = /^((control|ctrl|meta|cmd|command|mod|shift|alt)\+)*(enter|return)$/i;
/** A field whose Enter sends or posts it: a message, a reply, a comment, a post. */
const COMPOSER =
	/\b(message|messages|reply|comment|post|tweet|chat|compose|write|send|what'?s happening|what'?s on your mind|start a post|add a comment|type a message|say something)\b/;

function nameVerdict(name: string): Verdict<ActionRule> | undefined {
	if (!name || BACK_OUT.test(name)) return undefined;
	for (const r of ACTION_RULES) if (r.words.test(name)) return { rule: r.rule, why: r.why };
	return undefined;
}

/** What a commit on a control does, from its own name, then from the dialog or form it says yes to. */
function commitVerdict(t: TargetFacts, pageUrl: string | undefined): Verdict<ActionRule> | undefined {
	const name = squash(t.name);
	if (BACK_OUT.test(name)) return undefined;
	const page = urlOf(pageUrl);
	const where = urlOf(t.frameUrl) ?? page;
	// A yes on a consent page lets an app into the account, whatever the button says.
	if (where && OAUTH_PATH.test(where.pathname + where.search) && OAUTH_YES.test(name))
		return { rule: "oauth", why: "lets another app into your account" };
	const href = urlOf(t.href);
	if (href && RUNS_WHEN_OPENED.test(href.pathname))
		return { rule: "run-file", why: "downloads a program and runs it" };
	const own = nameVerdict(name);
	if (own) return own;
	if (!name || GENERIC_YES.test(name)) {
		// "Yes" in "Delete 3 files?" deletes them; "Continue" in a checkout form pays.
		const dialog = squash(t.dialog);
		const fromDialog = dialog ? DIALOG_WORDS.find((r) => r.words.test(dialog)) : undefined;
		if (fromDialog) return { rule: fromDialog.rule, why: fromDialog.why };
		const fromForm = formVerdict(t.form);
		if (fromForm) return fromForm;
		if (isAccountPage(where?.href)) return { rule: "account", why: "changes your account's settings" };
	}
	return undefined;
}

/** A form whose submit button or address says what it does. */
function formVerdict(form: TargetFacts["form"]): Verdict<ActionRule> | undefined {
	if (!form) return undefined;
	const bySubmit = nameVerdict(squash(form.submit));
	if (bySubmit) return bySubmit;
	const action = urlOf(form.action);
	if (!action) return undefined;
	const path = action.pathname.toLowerCase().replace(/[-_/.]+/g, " ");
	if (OAUTH_PATH.test(action.pathname)) return { rule: "oauth", why: "lets another app into your account" };
	return nameVerdict(path);
}

/**
 * Whether an action needs the person's yes in Auto (and Manual), and why. Reading the page, scrolling, hovering and
 * typing into a field are never risky; a commit is: a click on a control, Enter in a field, type with submit.
 */
export function actionRisk(f: ActionFacts): Verdict<ActionRule> | undefined {
	const t = f.target ?? {};
	const role = squash(t.role);
	const tool = f.tool;
	if (tool === "navigate") {
		const u = urlOf(f.url);
		if (!u) return undefined;
		if (RUNS_WHEN_OPENED.test(u.pathname)) return { rule: "run-file", why: "downloads a program and runs it" };
		return undefined;
	}
	if (tool === "click") {
		const inputType = squash(t.inputType);
		const committing =
			COMMIT_ROLES.has(role) || inputType === "submit" || inputType === "button" || inputType === "image";
		if (committing) return commitVerdict(t, f.url);
		// A switch or checkbox on a settings page changes the setting with the click.
		if (TOGGLE_ROLES.has(role) && isAccountPage(t.frameUrl ?? f.url))
			return { rule: "account", why: "changes your account's settings" };
		return undefined;
	}
	const enter = (tool === "press" && SENDS_FIELD.test((f.key ?? "").trim())) || (tool === "type" && f.submit === true);
	if (!enter) return undefined;
	// Enter in a field submits its form, or sends it when the field is a composer.
	const byForm = formVerdict(t.form);
	if (byForm) return byForm;
	const name = squash(t.name);
	if (COMPOSER.test(name)) {
		return /\b(comment|post|tweet|what'?s happening|what'?s on your mind|start a post|say something)\b/.test(name)
			? { rule: "post", why: "posts or publishes as you" }
			: { rule: "send", why: "sends a message as you" };
	}
	if (isAccountPage(t.frameUrl ?? f.url) && role !== "searchbox" && !/\bsearch\b/.test(name))
		return { rule: "account", why: "changes your account's settings" };
	return undefined;
}

// ---- Sensitive sites ----------------------------------------------------------------------------------------------

/** Domains by class. A host is in a class when it is one of these or a subdomain of one. */
export const SENSITIVE_DOMAINS: Readonly<Record<Exclude<SiteClass, "account-pages">, readonly string[]>> = {
	mail: [
		"mail.google.com",
		"inbox.google.com",
		"outlook.live.com",
		"outlook.office.com",
		"outlook.office365.com",
		"mail.yahoo.com",
		"mail.aol.com",
		"mail.proton.me",
		"mail.protonmail.com",
		"app.fastmail.com",
		"fastmail.com",
		"app.hey.com",
		"mail.zoho.com",
		"app.tuta.com",
		"mail.tutanota.com",
		"mail.yandex.com",
		"mail.gmx.com",
		"icloud.com",
	],
	bank: [
		"paypal.com",
		"venmo.com",
		"cash.app",
		"wise.com",
		"revolut.com",
		"monzo.com",
		"chase.com",
		"wellsfargo.com",
		"citi.com",
		"capitalone.com",
		"usbank.com",
		"americanexpress.com",
		"discover.com",
		"schwab.com",
		"fidelity.com",
		"vanguard.com",
		"robinhood.com",
		"etrade.com",
		"ally.com",
		"sofi.com",
		"coinbase.com",
		"kraken.com",
		"binance.com",
		"dashboard.stripe.com",
		"pay.google.com",
		"payments.google.com",
		"wallet.google.com",
		"zellepay.com",
		"klarna.com",
		"affirm.com",
		"mint.intuit.com",
		"creditkarma.com",
	],
	passwords: [
		"1password.com",
		"1password.eu",
		"1password.ca",
		"bitwarden.com",
		"bitwarden.eu",
		"lastpass.com",
		"dashlane.com",
		"keepersecurity.com",
		"keepersecurity.eu",
		"passwords.google.com",
		"pass.proton.me",
		"nordpass.com",
		"roboform.com",
		"enpass.io",
	],
	cloud: [
		"console.aws.amazon.com",
		"signin.aws.amazon.com",
		"portal.azure.com",
		"entra.microsoft.com",
		"admin.microsoft.com",
		"console.cloud.google.com",
		"admin.google.com",
		"dash.cloudflare.com",
		"app.netlify.com",
		"vercel.com",
		"cloud.digitalocean.com",
		"dashboard.heroku.com",
		"console.hetzner.cloud",
		"cloud.linode.com",
		"my.vultr.com",
		"app.supabase.com",
		"supabase.com",
		"console.firebase.google.com",
		"dcc.godaddy.com",
		"account.godaddy.com",
		"ap.www.namecheap.com",
		"porkbun.com",
		"domains.squarespace.com",
		"dnsimple.com",
		"gandi.net",
		"registrar.amazon.com",
	],
	government: ["login.gov", "id.me", "healthcare.gov"],
	health: [
		"mychart.com",
		"kp.org",
		"myhealth.va.gov",
		"followmyhealth.com",
		"healow.com",
		"patient.labcorp.com",
		"myquest.questdiagnostics.com",
		"onemedical.com",
		"teladoc.com",
		"zocdoc.com",
		"patientportal.com",
	],
};

const SITE_WHY: Record<SiteClass, string> = {
	mail: "your mail",
	bank: "your bank or payments",
	passwords: "your passwords",
	cloud: "a cloud console or your domains",
	government: "a government account",
	health: "your health records",
	"account-pages": "your account settings",
};

/** Government suffixes: a host under one is a government site. */
const GOV_SUFFIX =
	/\.(gov|mil|gov\.[a-z]{2}|gob\.[a-z]{2}|go\.[a-z]{2}|gouv\.[a-z]{2}|gc\.ca|gv\.at|admin\.ch|bund\.de|govt\.nz)$/;

/**
 * The sensitive class a URL is in, if any. In Auto, opening one asks even for a frontier model, until the person
 * allows the site; in Manual every new site asks anyway.
 */
export function sensitiveSite(url: string | undefined): Verdict<SiteClass> | undefined {
	const host = hostOf(url);
	if (!host) return undefined;
	for (const [cls, domains] of Object.entries(SENSITIVE_DOMAINS) as Array<[SiteClass, readonly string[]]>)
		if (domains.some((d) => onDomain(host, d))) return { rule: cls, why: `is ${SITE_WHY[cls]}` };
	const labels = host.split(".");
	// mail.example.com, webmail.example.org: a mail client, whoever runs it.
	if (labels.length > 2 && /^(web)?mail$/.test(labels[0])) return { rule: "mail", why: `is ${SITE_WHY.mail}` };
	// A bank names itself: bankofamerica.com, onlinebanking.example.com, examplebank.co.uk.
	if (labels.slice(0, -1).some((l) => /bank|banking|creditunion/.test(l)))
		return { rule: "bank", why: `is ${SITE_WHY.bank}` };
	if (GOV_SUFFIX.test(`.${host}`)) return { rule: "government", why: `is ${SITE_WHY.government}` };
	if (labels.some((l) => l === "mychart" || l === "patientportal"))
		return { rule: "health", why: `is ${SITE_WHY.health}` };
	if (isAccountPage(url)) return { rule: "account-pages", why: `is ${SITE_WHY["account-pages"]}` };
	return undefined;
}

// ---- Sensitive apps (computer use reads these when it reads the mode) ----------------------------------------------

export const SENSITIVE_APPS: Readonly<Record<AppClass, readonly string[]>> = {
	keychain: ["keychain access", "com.apple.keychainaccess", "seahorse", "kwalletmanager", "credential manager"],
	"system-settings": [
		"system settings",
		"system preferences",
		"com.apple.systempreferences",
		"gnome-control-center",
		"settings",
		"systemsettings",
		"control panel",
	],
	terminal: [
		"terminal",
		"com.apple.terminal",
		"iterm",
		"iterm2",
		"com.googlecode.iterm2",
		"warp",
		"ghostty",
		"kitty",
		"alacritty",
		"wezterm",
		"hyper",
		"gnome-terminal",
		"konsole",
		"xterm",
		"tilix",
		"foot",
		"windows terminal",
		"powershell",
		"pwsh",
		"cmd",
		"bash",
		"zsh",
		"fish",
		"sh",
	],
	"password-manager": [
		"1password",
		"1password 7",
		"com.1password.1password",
		"bitwarden",
		"lastpass",
		"dashlane",
		"keepassxc",
		"keepass",
		"keeper",
		"enpass",
		"passwords",
		"com.apple.passwords",
		"nordpass",
		"proton pass",
	],
};

const APP_WHY: Record<AppClass, string> = {
	keychain: "holds your saved passwords and keys",
	"system-settings": "changes how this computer is set up",
	terminal: "runs any command as you",
	"password-manager": "holds your passwords",
};

/** The sensitive class an app is in, by its name or bundle id ("Keychain Access", "com.apple.Terminal"). */
export function sensitiveApp(app: string | undefined): Verdict<AppClass> | undefined {
	const name = squash(app).replace(/\.app$/, "");
	if (!name) return undefined;
	for (const [cls, names] of Object.entries(SENSITIVE_APPS) as Array<[AppClass, readonly string[]]>)
		if (names.includes(name)) return { rule: cls, why: APP_WHY[cls] };
	return undefined;
}

// ---- Hard limits: refused in every mode, Yolo included ------------------------------------------------------------

/**
 * The hard limit on a field text is about to reach, if it has one. Self-contained: it also runs in the page, on the
 * field itself (page.ts FILL_LIB and FOCUS_LIB), so it names no other function or constant and keeps its own lists.
 */
export function textLimit(t: TargetFacts): HardLimit | undefined {
	const type = (t.inputType || "").toLowerCase();
	const auto = (t.autocomplete || "").toLowerCase();
	// A search box is named for what it finds; its own name is never a field's.
	const searching = type === "search" || (t.role || "").toLowerCase() === "searchbox";
	const name = searching ? "" : `${t.name || ""} | ${t.field || ""}`.toLowerCase().replace(/\s+/g, " ");
	// Named for a password: not one that only speaks of it (an email to reset it, its length).
	const secret = name.split(" | ").some((part) => {
		const said = /.*\b(password|passcode|passphrase)\b(.*)/.exec(part);
		if (!said || /\b(e-?mail|user ?name)\b/.test(part)) return false;
		return !said[2].trim() || !/\b(reset|forgot(ten)?|recover(y)?|length|hint|strength)\b/.test(part);
	});
	if (
		type === "password" ||
		/\b(current-password|new-password)\b/.test(auto) ||
		(secret && !/^(email|url|number|range|date|datetime-local|month|week|time)$/.test(type))
	)
		return "password-field";
	// A card field by its autocomplete, or by its name when the page gave it none.
	if (
		/\bcc-(number|csc|exp|exp-month|exp-year|name|type|given-name|family-name)\b/.test(auto) ||
		/\b(card ?number|credit card|debit card|cc ?number|cvc|cvv|cvv2|csc|security code|card verification|expiry|expiration( date)?|exp(\.|iry)? date|mm ?\/ ?yy|iban|routing number|account number|sort code)\b/.test(
			name,
		)
	)
		return "payment-field";
	// Frames that are card fields (Stripe Elements, Braintree, Adyen and the like).
	const host =
		/^https?:\/\/(?:[^/?#]*@)?([^/?#:]+)/i
			.exec(t.frameUrl || "")?.[1]
			?.toLowerCase()
			.replace(/\.$/, "") || "";
	const card =
		/(^|\.)(js\.stripe\.com|checkout\.stripe\.com|assets\.braintreegateway\.com|checkoutshopper-live\.adyen\.com|checkoutshopper-test\.adyen\.com|pay\.google\.com|secure\.checkout\.com|js\.squareup\.com|web\.squarecdn\.com|flex\.cybersource\.com|pci-connect\.squareup\.com|checkout\.paypal\.com|www\.paypal\.com|secure\.authorize\.net|pay\.shopify\.com|checkout\.shopifycs\.com)$/;
	return card.test(host) ? "payment-field" : undefined;
}

const LIMIT_WHY: Record<HardLimit, string> = {
	"password-field": "is a password field",
	"payment-field": "is a payment field",
};

/** The hard limit as the person reads it ("is a password field"). */
export const limitWhy = (limit: HardLimit): string => LIMIT_WHY[limit];

/**
 * What no mode lets an agent do: type a password or a payment detail. The person types those themselves (the agent
 * calls tabs_show, with password_ref for a password). Checked before the mode, in Yolo too.
 */
export function hardLimit(f: ActionFacts): Verdict<HardLimit> | undefined {
	// A press of Enter or Tab enters no text; a press of a character does.
	if (!f.target || !entersText(f.tool, f.key)) return undefined;
	const rule = textLimit(f.target);
	return rule && { rule, why: limitWhy(rule) };
}

/**
 * Everything the labeled set scores (evals/market/risky-actions): an action is risky when a hard limit refuses it,
 * an action rule asks for it, or it opens a sensitive site.
 */
export function isRiskyAction(f: ActionFacts): boolean {
	if (hardLimit(f) || actionRisk(f)) return true;
	return f.tool === "navigate" && sensitiveSite(f.url) !== undefined;
}

/** Whether a tool call enters text into the field it names or the one in focus: the hard limits look at it first. */
export function entersText(tool: string, key?: string): boolean {
	if (tool !== "press") return tool === "fill" || tool === "type";
	// Read as pressKey reads a chord: an unknown modifier is none.
	const parts = (key ?? "").split("+").map((p) => p.trim());
	const main = parts.pop() ?? "";
	const held = (names: RegExp) => parts.some((m) => names.test(m));
	// A paste, though pressKey refuses it too. Alt with a character writes one on a Mac.
	if (/^insert$/i.test(main)) return held(/^shift$/i);
	return /^(.|space)$/iu.test(main) && (/^v$/i.test(main) || !held(/^(cmd|command|meta|win|ctrl|control)$/i));
}
