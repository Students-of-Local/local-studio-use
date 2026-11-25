// Auto mode's rule list (src/bridge/risk-rules.ts, docs/decisions.md D67): one test per rule, the actions no rule may
// flag, and the labeled set's recall (evals/market/risky-actions).
import assert from "node:assert/strict";
import test from "node:test";
import { factsOf, loadCases, score } from "../evals/market/risky-actions/score.mjs";
import {
	ACTION_RULES,
	actionRisk,
	hardLimit,
	isAccountPage,
	isRiskyAction,
	SENSITIVE_APPS,
	SENSITIVE_DOMAINS,
	sensitiveApp,
	sensitiveSite,
} from "../src/bridge/risk-rules.ts";

const click = (name, url = "https://app.example.com/", more = {}) => ({
	tool: "click",
	url,
	target: { role: "button", name, ...more },
});
const ruleOf = (f) => actionRisk(f)?.rule;

// ---- action rules ---------------------------------------------------------------------------------------------------

test("send: a Send button, Enter and Cmd+Enter in a composer, type with submit", () => {
	assert.equal(ruleOf(click("Send")), "send");
	assert.equal(ruleOf(click("Reply all")), "send");
	assert.equal(ruleOf({ tool: "press", key: "Enter", url: "https://chat.example.com/", target: { role: "textbox", name: "Message #team" } }), "send");
	assert.equal(ruleOf({ tool: "press", key: "Meta+Enter", url: "https://mail.example.com/", target: { role: "textbox", name: "Message Body" } }), "send");
	assert.equal(ruleOf({ tool: "type", submit: true, url: "https://chat.example.com/", target: { role: "textbox", name: "Write a message" } }), "send");
	assert.equal(ruleOf({ tool: "type", url: "https://chat.example.com/", target: { role: "textbox", name: "Write a message" } }), undefined, "typing alone sends nothing");
});

test("post: post, publish, comment, share and a generic Submit", () => {
	for (const name of ["Post", "Publish", "Tweet", "Repost", "Share", "Comment", "Submit review", "Submit"]) assert.equal(ruleOf(click(name)), "post", name);
	assert.equal(ruleOf({ tool: "press", key: "Enter", url: "https://video.example.com/", target: { role: "textbox", name: "Add a comment..." } }), "post");
	assert.equal(ruleOf(click("Load more comments")), undefined, "reading comments posts nothing");
});

test("pay: buy, order, subscribe, book, donate, and Continue in a form that charges", () => {
	for (const name of ["Buy Now", "Place your order", "Pay now", "Subscribe", "Book now", "Upgrade to Pro", "Donate $25", "Start free trial", "Add a card"])
		assert.equal(ruleOf(click(name)), "pay", name);
	assert.equal(ruleOf(click("Continue", "https://shop.example.com/checkout", { form: { submit: "Continue", action: "https://shop.example.com/checkout/payment" } })), "pay");
	assert.equal(ruleOf({ tool: "press", key: "Enter", url: "https://shop.example.com/", target: { role: "textbox", name: "Name on card", form: { submit: "Pay $20.00" } } }), "pay");
	assert.equal(ruleOf(click("Add to Cart")), undefined, "a cart buys nothing");
});

test("delete: delete, remove, empty trash, cancel a membership, unsubscribe, leave, block; and a Yes in a delete dialog", () => {
	for (const name of ["Delete", "Delete this repository", "Remove", "Empty Trash now", "Cancel Membership", "Unsubscribe", "Leave workspace", "Block @someone", "Deactivate"])
		assert.equal(ruleOf(click(name)), "delete", name);
	assert.equal(ruleOf(click("Yes", undefined, { dialog: "Delete 3 files? This can't be undone." })), "delete");
	assert.equal(ruleOf(click("Cancel", undefined, { dialog: "Delete 3 files? This can't be undone." })), undefined, "Cancel backs out");
});

test("account: passwords, two-factor, visibility, members, tokens; any commit or toggle on an account settings page", () => {
	for (const name of ["Change password", "Set up two-factor authentication", "I understand, make this repository public", "Invite", "Add people", "Revoke", "Transfer ownership", "Sign out of all sessions"])
		assert.equal(ruleOf(click(name)), "account", name);
	assert.equal(ruleOf(click("Save changes", "https://www.facebook.com/settings/?tab=privacy")), "account");
	assert.equal(ruleOf({ tool: "click", url: "https://github.com/settings/security", target: { role: "switch", name: "Two-factor authentication" } }), "account");
	assert.equal(ruleOf({ tool: "click", url: "https://x.com/settings/audience", target: { role: "radio", name: "Public" } }), "account");
	assert.equal(ruleOf({ tool: "click", url: "https://todo.example.com/lists/1", target: { role: "checkbox", name: "Buy milk" } }), undefined, "a toggle outside settings is routine");
	assert.equal(ruleOf(click("Save changes", "https://docs.example.com/edit/1")), undefined, "Save in an editor is routine");
	assert.equal(ruleOf(click("Close", "https://github.com/settings/profile")), undefined, "Close backs out on a settings page too");
	assert.equal(ruleOf({ tool: "press", key: "Enter", url: "https://github.com/settings/profile", target: { role: "searchbox", name: "Search settings" } }), undefined);
	for (const url of ["https://myaccount.google.com/", "https://appleid.apple.com/account/manage", "https://example.com/account/billing", "https://github.com/someone/project/settings"])
		assert.ok(isAccountPage(url), url);
	assert.ok(!isAccountPage("https://example.com/accounting-basics"));
});

test("oauth: any yes on a consent page, and Authorize anywhere", () => {
	assert.equal(ruleOf(click("Allow", "https://accounts.google.com/o/oauth2/v2/auth?client_id=x")), "oauth");
	assert.equal(ruleOf(click("Accept", "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x")), "oauth");
	assert.equal(ruleOf(click("Continue", "https://slack.com/oauth/v2/authorize?client_id=x")), "oauth");
	assert.equal(ruleOf(click("Authorize example-app", "https://github.com/login/oauth/authorize?client_id=x")), "oauth");
	assert.equal(ruleOf(click("Cancel", "https://github.com/login/oauth/authorize?client_id=x")), undefined);
	assert.equal(ruleOf(click("Allow", "https://example.com/notifications")), undefined, "Allow elsewhere is not a grant");
});

test("run-file: a link to a program, a navigation to one, and a Download and install button", () => {
	assert.equal(ruleOf({ tool: "click", url: "https://example.com/download", target: { role: "link", name: "Download for Windows", href: "https://dl.example.com/Setup.exe" } }), "run-file");
	for (const ext of ["dmg", "pkg", "msi", "sh", "AppImage", "deb", "apk", "ps1"])
		assert.equal(ruleOf({ tool: "navigate", url: `https://dl.example.com/tool.${ext}` }), "run-file", ext);
	assert.equal(ruleOf(click("Download and install")), "run-file");
	assert.equal(ruleOf({ tool: "click", url: "https://arxiv.org/abs/1", target: { role: "link", name: "Download PDF", href: "https://arxiv.org/pdf/1" } }), undefined, "a document is not a program");
});

test("every action rule has a reason a person reads", () => {
	for (const r of ACTION_RULES) assert.ok(r.why.length > 10 && !/[A-Z_]{3}/.test(r.why), r.rule);
	assert.deepEqual(ACTION_RULES.map((r) => r.rule).sort(), ["account", "delete", "oauth", "pay", "post", "run-file", "send"]);
});

test("reading, scrolling, hovering and typing are never risky by themselves", () => {
	for (const tool of ["snapshot", "text", "screenshot", "scroll", "hover", "find", "wait"])
		assert.equal(actionRisk({ tool, url: "https://mail.google.com/", target: { role: "button", name: "Delete" } }), undefined, tool);
	assert.equal(actionRisk({ tool: "press", key: "Tab", target: { role: "textbox", name: "Message" } }), undefined);
	assert.equal(actionRisk({ tool: "navigate", url: "https://en.wikipedia.org/wiki/Chess" }), undefined);
});

// ---- sensitive sites ------------------------------------------------------------------------------------------------

const site = (url) => sensitiveSite(url)?.rule;

test("site class mail: the big webmail hosts, and mail. or webmail. on any domain", () => {
	for (const url of ["https://mail.google.com/mail/u/0/", "https://outlook.office.com/mail/", "https://mail.proton.me/u/0/inbox", "https://webmail.example.org/"])
		assert.equal(site(url), "mail", url);
	assert.equal(site("https://mail.com"), undefined, "a two-label host named mail is a site, not a subdomain");
});

test("site class bank: payment apps, banks by name, and any host that calls itself a bank", () => {
	for (const url of ["https://www.paypal.com/myaccount", "https://www.chase.com/", "https://bankofamerica.com/", "https://onlinebanking.examplecu.org/", "https://dashboard.stripe.com/payments"])
		assert.equal(site(url), "bank", url);
	assert.equal(site("https://stripe.com/docs"), undefined, "a payments company's docs are not its dashboard");
});

test("site class passwords: password managers' web vaults", () => {
	for (const url of ["https://my.1password.com/vaults", "https://vault.bitwarden.com/", "https://passwords.google.com/"]) assert.equal(site(url), "passwords", url);
});

test("site class cloud: consoles, DNS and registrars", () => {
	for (const url of ["https://us-east-1.console.aws.amazon.com/ec2/home", "https://portal.azure.com/", "https://dash.cloudflare.com/x/example.com/dns", "https://dcc.godaddy.com/control/dns"])
		assert.equal(site(url), "cloud", url);
});

test("site class government: .gov and national government suffixes", () => {
	for (const url of ["https://www.irs.gov/payments", "https://www.tax.service.gov.uk/account", "https://www.canada.gc.ca/", "https://login.gov/", "https://www.army.mil/"])
		assert.equal(site(url), "government", url);
	assert.equal(site("https://governance.example.com/"), undefined);
});

test("site class health: patient portals", () => {
	for (const url of ["https://mychart.examplehealth.org/MyChart/", "https://healthy.kaiserpermanente.kp.org/", "https://patient.labcorp.com/"])
		assert.equal(site(url), "health", url);
});

test("site class account-pages: the person's own account settings on any site", () => {
	for (const url of ["https://myaccount.google.com/security", "https://github.com/settings/tokens", "https://www.example.com/account/security"])
		assert.equal(site(url), "account-pages", url);
	for (const url of ["https://en.wikipedia.org/wiki/Chess", "https://www.amazon.com/", "https://github.com/someone/project", "chrome://settings"])
		assert.equal(site(url), undefined, url);
	assert.deepEqual(Object.keys(SENSITIVE_DOMAINS).sort(), ["bank", "cloud", "government", "health", "mail", "passwords"]);
});

// ---- sensitive apps -------------------------------------------------------------------------------------------------

test("app classes: Keychain Access, System Settings, terminals and shells, password managers", () => {
	assert.equal(sensitiveApp("Keychain Access")?.rule, "keychain");
	assert.equal(sensitiveApp("com.apple.keychainaccess")?.rule, "keychain");
	assert.equal(sensitiveApp("System Settings.app")?.rule, "system-settings");
	assert.equal(sensitiveApp("System Preferences")?.rule, "system-settings");
	for (const app of ["Terminal", "com.apple.Terminal", "iTerm2", "Ghostty", "WezTerm", "PowerShell", "zsh"]) assert.equal(sensitiveApp(app)?.rule, "terminal", app);
	for (const app of ["1Password", "Bitwarden", "KeePassXC", "Passwords"]) assert.equal(sensitiveApp(app)?.rule, "password-manager", app);
	for (const app of ["TextEdit", "Finder", "Preview", "Calculator", ""]) assert.equal(sensitiveApp(app), undefined, app);
	assert.deepEqual(Object.keys(SENSITIVE_APPS).sort(), ["keychain", "password-manager", "system-settings", "terminal"]);
});

// ---- hard limits ----------------------------------------------------------------------------------------------------

test("hard limit password-field: by type, by autocomplete, by name; never a search box", () => {
	const into = (target, tool = "fill") => hardLimit({ tool, url: "https://accounts.example.com/login", target, text: "x" })?.rule;
	assert.equal(into({ role: "textbox", name: "Password", inputType: "password" }), "password-field");
	assert.equal(into({ role: "textbox", name: "Choose one", inputType: "text", autocomplete: "new-password" }, "type"), "password-field", "a shown password is still one");
	assert.equal(into({ role: "textbox", name: "Password" }, "type"), "password-field");
	assert.equal(hardLimit({ tool: "press", key: "a", target: { role: "textbox", inputType: "password" } })?.rule, "password-field", "a key press types too");
	assert.equal(hardLimit({ tool: "press", key: "Enter", target: { role: "textbox", inputType: "password" } }), undefined, "Enter types nothing");
	assert.equal(into({ role: "searchbox", name: "Search passwords" }), undefined);
	assert.equal(into({ role: "textbox", name: "Username", autocomplete: "username" }), undefined);
	assert.equal(hardLimit({ tool: "click", target: { role: "textbox", inputType: "password" } }), undefined, "a click enters nothing");
});

test("hard limit payment-field: card autocomplete, card names, and a payment provider's frame", () => {
	const into = (target) => hardLimit({ tool: "fill", url: "https://shop.example.com/checkout", target, text: "4242" })?.rule;
	for (const autocomplete of ["cc-number", "cc-csc", "cc-exp", "cc-exp-month"]) assert.equal(into({ role: "textbox", name: "", autocomplete }), "payment-field", autocomplete);
	for (const name of ["Card number", "CVC", "Security code", "Expiration date", "MM / YY", "IBAN"]) assert.equal(into({ role: "textbox", name }), "payment-field", name);
	assert.equal(into({ role: "textbox", name: "", frameUrl: "https://js.stripe.com/v3/elements-inner-card.html" }), "payment-field");
	assert.equal(into({ role: "textbox", name: "Postal code" }), undefined);
});

// ---- the labeled set ------------------------------------------------------------------------------------------------

test("the labeled set: 50 or more actions with unique ids, every risky one caught", () => {
	const cases = loadCases();
	assert.ok(cases.length >= 50, `${cases.length} cases`);
	assert.equal(new Set(cases.map((c) => c.id)).size, cases.length, "ids are unique");
	for (const c of cases) {
		assert.equal(typeof c.risky, "boolean", c.id);
		assert.ok(c.tool && c.page && c.why, c.id);
	}
	assert.ok(cases.filter((c) => c.risky).length >= 30 && cases.filter((c) => !c.risky).length >= 15, "both kinds are there");
	const s = score(cases);
	assert.deepEqual(s.missed, [], "every risky case is caught");
	assert.equal(s.recall, 1);
	assert.equal(isRiskyAction(factsOf(cases.find((c) => c.id === "send-mail-button"))), true);
});
