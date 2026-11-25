/** What the model page lists: one group per provider, newest first, and what a search finds. */

import type { Model } from "@mariozechner/pi-ai";
import { modelDisplayName, providerDisplayName } from "./display.js";

export type AnyModel = Model<any>;

/** A group shows this many until its "Show all" is pressed. */
export const SHOWN = 4;

export interface Group {
	provider: string;
	name: string;
	models: AnyModel[];
}

const same = (a: AnyModel | null | undefined, b: AnyModel): boolean => a?.id === b.id && a?.provider === b.provider;

/** The first number that reads as a version: 5.5 of "Opus 5.5", 3 of "Gemini 3 Pro"; never a size (70B) or a date. */
function version(name: string): number {
	for (const [, number, after] of name.matchAll(/(\d+(?:\.\d+)?)([a-z]*)/gi))
		if (Number(number) < 100 && !/^[bkm]$/i.test(after)) return Number(number);
	return 0;
}

function newestFirst(a: AnyModel, b: AnyModel): number {
	const [x, y] = [modelDisplayName(a), modelDisplayName(b)];
	return version(y) - version(x) || x.localeCompare(y, undefined, { numeric: true });
}

/** Dated copies of one model share a name: the newest id stands for them, or the one in use. */
function oneEach(models: AnyModel[], current: AnyModel | null): AnyModel[] {
	const held = new Map<string, AnyModel>();
	for (const model of models) {
		const key = modelDisplayName(model).replace(/ \(latest\)$/, "");
		const before = held.get(key);
		if (!before || same(current, model) || (model.id > before.id && !same(current, before))) held.set(key, model);
	}
	return [...held.values()];
}

/** One group per provider: the one in use first, then Local Studio's, then by name; the model in use leads its group. */
export function modelGroups(models: AnyModel[], current: AnyModel | null): Group[] {
	const by = new Map<string, AnyModel[]>();
	for (const model of models) by.set(model.provider, [...(by.get(model.provider) ?? []), model]);
	const rank = (provider: string) => (provider === current?.provider ? 0 : provider === "local-studio" ? 1 : 2);
	return [...by]
		.map(([provider, list]) => ({
			provider,
			name: providerDisplayName(provider),
			models: oneEach(list, current).sort(
				(a, b) => Number(same(current, b)) - Number(same(current, a)) || newestFirst(a, b),
			),
		}))
		.sort((a, b) => rank(a.provider) - rank(b.provider) || a.name.localeCompare(b.name));
}

/** Each of the query's characters in order, tighter runs scoring higher; 0 is no match. */
function score(query: string, text: string): number {
	let at = -1;
	let gaps = 0;
	for (const char of query) {
		const next = text.indexOf(char, at + 1);
		if (next < 0) return 0;
		if (at >= 0) gaps += next - at - 1;
		at = next;
	}
	return query.length / (query.length + gaps);
}

/** What the search box finds, best first. Every word has to be there; "images" and "thinking" find what can. */
export function findModels(models: AnyModel[], query: string): AnyModel[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return models
		.map((model) => {
			const text = [
				providerDisplayName(model.provider),
				modelDisplayName(model),
				model.id,
				model.reasoning ? "thinking" : "",
				model.input?.includes("image") ? "images vision" : "",
			]
				.join(" ")
				.toLowerCase();
			const scores = words.map((word) => (text.includes(word) ? 1 : score(word, text) * 0.5));
			return { model, score: scores.some((s) => s === 0) ? 0 : scores.reduce((a, b) => a + b, 0) };
		})
		.filter((found) => found.score > 0)
		.sort((a, b) => b.score - a.score || newestFirst(a.model, b.model))
		.map((found) => found.model);
}

const money = (amount: number): string => `$${Number(amount.toFixed(2))}`;

/** What a person compares models by, in few words: prices are per million tokens, as the page says once. */
export function modelFacts(model: AnyModel): string {
	const window = model.contextWindow;
	const context = window >= 1_000_000 ? `${Math.round(window / 1_000_000)}M` : `${Math.round(window / 1000)}K`;
	const { input, output } = model.cost;
	return [
		input === 0 && output === 0 ? "Free" : `${money(input)} in`,
		input === 0 && output === 0 ? "" : `${money(output)} out`,
		`${context} context`,
		model.input?.includes("image") ? "" : "no images",
	]
		.filter(Boolean)
		.join(" · ");
}
