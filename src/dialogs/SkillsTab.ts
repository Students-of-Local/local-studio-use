import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { icon } from "@mariozechner/mini-lit/dist/icons.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, nothing, type TemplateResult } from "lit";
import { ChevronRight } from "lucide";
import { Toast } from "../components/Toast.js";
import { bySkillGroup } from "../composer/skill-groups.js";
import { getLocalStudioStorage } from "../storage/app-storage.js";
import type { Skill } from "../storage/stores/skills-store.js";
import {
	type LibraryRow,
	libraryRows,
	listableSkill,
	normalizeSkillQuery,
	validateImportedSkills,
} from "./skill-list.js";

/**
 * Settings > Skills: a search, the site skills of the page in front of the person, the bundled skills by group, then
 * every site skill. Groups and skills open in place, so the list is short until someone asks for more.
 */
export class SkillsTab extends SettingsTab {
	label = "Skills";
	/** Puts a skill in the chat input; set by the side panel. */
	onUse?: (name: string) => void;
	/** Open groups and skills, by key. */
	private open = new Set<string>();
	/** Site skills for the page in the active tab. */
	private onPage = new Set<string>();
	private pageHost = "";
	private skills: Skill[] = [];
	private filteredSkills: Skill[] = [];
	private searchQuery = "";
	private editingSkill: Skill | null = null;
	private importConflicts: { skill: Skill; selected: boolean }[] = [];
	private importedSkills: Skill[] = [];
	private library: readonly { name: string; description: string; text: string }[] = [];
	getTabName(): string {
		return this.label;
	}

	async connectedCallback() {
		super.connectedCallback();
		void import("virtual:library-skills").then(({ LIBRARY_SKILLS }) => {
			this.library = LIBRARY_SKILLS;
			this.requestUpdate();
		});
		await this.loadSkills();
	}

	async loadSkills() {
		const storage = getLocalStudioStorage();
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
		if (tab?.url && /^https?:/.test(tab.url)) {
			this.pageHost = new URL(tab.url).hostname.replace(/^www\./, "");
			this.onPage = new Set((await storage.skills.list(tab.url)).map((s) => s.name));
		}
		this.skills = await storage.skills
			.list()
			.then((list) =>
				Promise.all(list.map((s) => storage.skills.get(s.name))).then((skills) =>
					(skills.filter(Boolean) as Skill[]).map(listableSkill),
				),
			);
		this.filterSkills();
	}

	filterSkills() {
		const query = normalizeSkillQuery(this.searchQuery);
		this.filteredSkills = this.skills.filter(
			(s) =>
				s.name.toLowerCase().includes(query) ||
				s.domainPatterns.some((p: string) => p.toLowerCase().includes(query)) ||
				s.shortDescription.toLowerCase().includes(query),
		);
		this.requestUpdate();
	}

	onSearchInput(e: Event) {
		this.searchQuery = (e.target as HTMLInputElement).value;
		this.filterSkills();
	}

	async deleteSkill(skill: Skill) {
		if (!confirm(`Delete skill "${skill.name}"?`)) return;

		const storage = getLocalStudioStorage();
		await storage.skills.delete(skill.name);
		await this.loadSkills();
	}

	editSkill(skill: Skill) {
		this.editingSkill = { ...skill };
		this.requestUpdate();
	}

	cancelEdit() {
		this.editingSkill = null;
		this.requestUpdate();
	}

	async saveEdit() {
		if (!this.editingSkill) return;
		const storage = getLocalStudioStorage();
		const toSave: Skill = {
			...this.editingSkill,
			lastUpdated: new Date().toISOString(),
		};
		await storage.skills.save(toSave);
		this.editingSkill = null;
		await this.loadSkills();
	}

	updateEditField(field: keyof Skill, value: string | string[]) {
		if (!this.editingSkill) return;
		this.editingSkill = { ...this.editingSkill, [field]: value };
		this.requestUpdate();
	}

	async exportSkills() {
		const storage = getLocalStudioStorage();
		const allSkills = await storage.skills
			.list()
			.then((list) =>
				Promise.all(list.map((s) => storage.skills.get(s.name))).then(
					(skills) => skills.filter(Boolean) as Skill[],
				),
			);

		const json = JSON.stringify(allSkills, null, 2);
		const blob = new Blob([json], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `local-studio-skills-${new Date().toISOString().split("T")[0]}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}

	async importSkills() {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "application/json,.json";
		input.onchange = async (e) => {
			const file = (e.target as HTMLInputElement).files?.[0];
			if (!file) return;

			try {
				const text = await file.text();
				const checked = validateImportedSkills(JSON.parse(text));
				if ("error" in checked) {
					Toast.error(checked.error);
					return;
				}
				const imported = checked.skills;

				// Store imported skills for later
				this.importedSkills = imported;

				// Check for conflicts
				const storage = getLocalStudioStorage();
				const conflicts: { skill: Skill; selected: boolean }[] = [];

				for (const skill of imported) {
					const existing = await storage.skills.get(skill.name);
					if (existing) {
						conflicts.push({ skill, selected: true });
					}
				}

				if (conflicts.length > 0) {
					// Show conflict resolution UI
					this.importConflicts = conflicts;
					this.requestUpdate();
				} else {
					// No conflicts, import all
					await this.performImport(imported);
				}
			} catch (error) {
				Toast.error(`Failed to import skills: ${(error as Error).message}`);
			}
		};
		input.click();
	}

	async performImport(skills: Skill[]) {
		const storage = getLocalStudioStorage();

		// Filter out skills that are in conflicts and not selected
		const conflictNames = new Set(this.importConflicts.filter((c) => !c.selected).map((c) => c.skill.name));
		const toImport = skills.filter((s) => !conflictNames.has(s.name));

		let imported = 0;
		for (const skill of toImport) {
			await storage.skills.save(skill);
			imported++;
		}

		this.importConflicts = [];
		await this.loadSkills();
		Toast.success(`Imported ${imported} skill(s)`);
	}

	toggleConflictSelection(index: number) {
		this.importConflicts[index].selected = !this.importConflicts[index].selected;
		this.requestUpdate();
	}

	cancelImport() {
		this.importConflicts = [];
		this.importedSkills = [];
		this.requestUpdate();
	}

	private toggle(key: string) {
		if (!this.open.delete(key)) this.open.add(key);
		this.requestUpdate();
	}

	/** A row that opens in place: its name, a short line, and what it holds. */
	private opener(
		key: string,
		title: TemplateResult,
		aside: string,
		body: () => TemplateResult,
		forced = false,
	): TemplateResult {
		const open = forced || this.open.has(key);
		return html`
			<div>
				<button
					type="button"
					class="tk-row tk-row-link"
					data-open=${key}
					aria-expanded=${open ? "true" : "false"}
					@click=${() => this.toggle(key)}
				>
					${title}
					${aside ? html`<span class="tk-row-state">${aside}</span>` : nothing}
					<span class="tk-row-chevron ${open ? "rotate-90" : ""}" aria-hidden="true">${icon(ChevronRight, "sm")}</span>
				</button>
				${open ? body() : nothing}
			</div>
		`;
	}

	private useButton(name: string): TemplateResult {
		return Button({ variant: "outline", size: "sm", onClick: () => this.onUse?.(name), children: "Use in chat" });
	}

	renderSkillInfo(skill: Skill) {
		if (this.editingSkill?.name === skill.name) return this.renderSkillEditor(this.editingSkill);
		return this.opener(
			`site:${skill.name}`,
			html`<span class="min-w-0 flex-1">
				<span class="block truncate text-sm text-foreground">${skill.name}</span>
				${this.open.has(`site:${skill.name}`) ? nothing : html`<span class="block truncate text-xs text-muted-foreground">${skill.shortDescription}</span>`}
			</span>`,
			"",
			() => html`
				<div class="flex flex-col gap-2 px-3 pb-3">
					<p class="text-xs text-muted-foreground">${skill.shortDescription}</p>
					<p class="text-xs text-muted-foreground font-mono break-words">${skill.domainPatterns.join(", ")}</p>
					<div class="flex flex-wrap gap-2">
						${this.useButton(skill.name)}
						${Button({ variant: "outline", size: "sm", onClick: () => this.editSkill(skill), children: "Edit" })}
						<button
							type="button"
							class="h-8 rounded-md px-3 text-xs font-medium text-destructive hover:bg-destructive/10 outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
							@click=${() => this.deleteSkill(skill)}
						>
							Delete
						</button>
					</div>
				</div>
			`,
		);
	}

	private renderBundled(row: LibraryRow): TemplateResult {
		return html`<div data-skill=${row.name}>
			${this.opener(
				`skill:${row.name}`,
				html`<span class="min-w-0 flex-1">
					<span class="block truncate text-sm text-foreground">${row.name}</span>
					${this.open.has(`skill:${row.name}`) ? nothing : html`<span class="block truncate text-xs text-muted-foreground">${row.summary}</span>`}
				</span>`,
				"",
				() => html`
					<div class="flex flex-col items-start gap-2 px-3 pb-3">
						<p class="text-xs text-muted-foreground">${row.description}</p>
						${row.sharesNameWithSiteSkill ? html`<p class="text-xs text-muted-foreground">A site skill has this name; on its sites, /${row.name} runs the site skill.</p>` : nothing}
						${this.useButton(row.name)}
					</div>
				`,
			)}
		</div>`;
	}

	renderSkillEditor(skill: Skill) {
		return html`
			<div class="border border-border rounded-lg p-4 bg-card space-y-4">
				<h3 class="font-semibold text-foreground">Edit Skill: ${skill.name}</h3>

				${Input({
					label: "Name (cannot be changed)",
					type: "text",
					value: skill.name,
					disabled: true,
				})}

				${Input({
					label: "Domain Patterns (comma-separated)",
					type: "text",
					value: skill.domainPatterns.join(", "),
					onInput: (e) => {
						const value = (e.target as HTMLInputElement).value;
						const patterns = value
							.split(",")
							.map((p) => p.trim())
							.filter((p) => p.length > 0);
						this.updateEditField("domainPatterns", patterns);
					},
				})}

				${Input({
					label: "Short Description",
					type: "text",
					value: skill.shortDescription,
					onInput: (e) => this.updateEditField("shortDescription", (e.target as HTMLInputElement).value),
				})}

				<div class="space-y-2">
					<label class="text-sm font-medium text-foreground">Description (Markdown)</label>
					<textarea
						class="w-full min-h-[100px] px-3 py-2 text-sm text-foreground bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
						.value=${skill.description}
						@input=${(e: Event) => this.updateEditField("description", (e.target as HTMLTextAreaElement).value)}
					></textarea>
				</div>

				<div class="space-y-2">
					<label class="text-sm font-medium text-foreground">Examples (JavaScript)</label>
					<textarea
						class="w-full min-h-[100px] px-3 py-2 text-xs text-foreground bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring font-mono"
						.value=${skill.examples}
						@input=${(e: Event) => this.updateEditField("examples", (e.target as HTMLTextAreaElement).value)}
					></textarea>
				</div>

				<div class="space-y-2">
					<label class="text-sm font-medium text-foreground">Library Code</label>
					<textarea
						class="w-full min-h-[200px] px-3 py-2 text-xs text-foreground bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring font-mono"
						.value=${skill.library}
						@input=${(e: Event) => this.updateEditField("library", (e.target as HTMLTextAreaElement).value)}
					></textarea>
				</div>

				<div class="flex justify-end gap-2">
					${Button({
						variant: "outline",
						onClick: () => this.cancelEdit(),
						children: "Cancel",
					})}
					${Button({
						variant: "default",
						onClick: () => this.saveEdit(),
						children: "Save",
					})}
				</div>
			</div>
		`;
	}

	renderConflictResolution() {
		return html`
			<div class="border border-border rounded-lg p-4 bg-card space-y-4">
				<h3 class="font-semibold text-foreground">Import Conflicts</h3>
				<p class="text-sm text-muted-foreground">
					The following skills already exist. Check the skills you want to overwrite:
				</p>

				<div class="space-y-2">
					${this.importConflicts.map(
						(conflict, index) => html`
						<label class="flex items-start gap-3 p-3 border border-border rounded cursor-pointer hover:bg-muted/50">
							<input
								type="checkbox"
								.checked=${conflict.selected}
								@change=${() => this.toggleConflictSelection(index)}
								class="mt-1"
							/>
							<div class="flex-1">
								<div class="font-medium text-foreground">${conflict.skill.name}</div>
								<div class="text-xs text-muted-foreground">${conflict.skill.domainPatterns.join(", ")}</div>
								<div class="text-sm text-muted-foreground mt-1">${conflict.skill.shortDescription}</div>
							</div>
						</label>
					`,
					)}
				</div>

				<div class="flex justify-end gap-2">
					${Button({
						variant: "outline",
						onClick: () => this.cancelImport(),
						children: "Cancel",
					})}
					${Button({
						variant: "default",
						onClick: () => this.performImport(this.importedSkills),
						children: "Import Selected",
					})}
				</div>
			</div>
		`;
	}

	/** Every bundled skill, in its group. A search opens the groups that match and leaves out the rest. */
	private renderGroups(): TemplateResult {
		const siteNames = new Set(this.skills.map((s) => s.name));
		const rows = libraryRows(this.library, this.searchQuery, siteNames);
		const searching = Boolean(this.searchQuery.trim());
		if (rows.length === 0) return html``;
		return html`<div class="tk-list" data-testid="library-skills">
			${bySkillGroup(rows).map((group) =>
				this.opener(
					`group:${group.name}`,
					html`<span class="tk-row-name">${group.name}</span>`,
					String(group.items.length),
					() => html`<div class="tk-list-inner">${group.items.map((row) => this.renderBundled(row))}</div>`,
					searching,
				),
			)}
		</div>`;
	}

	render() {
		// Show conflict resolution UI if there are conflicts
		if (this.importConflicts.length > 0) {
			return html`
				<div class="flex flex-col gap-6">
					${this.renderConflictResolution()}
				</div>
			`;
		}

		const here = this.filteredSkills.filter((s) => this.onPage.has(s.name));
		const elsewhere = this.filteredSkills.filter((s) => !this.onPage.has(s.name));
		const bundled = libraryRows(this.library, this.searchQuery).length;
		return html`
			<div class="flex flex-col gap-5">
				<input
					type="search"
					aria-label="Find a skill"
					placeholder="Find a skill"
					.value=${this.searchQuery}
					@input=${(e: Event) => this.onSearchInput(e)}
					class="tk-search"
				/>

				${
					here.length > 0
						? html`<section class="flex flex-col gap-2">
								<h3 class="tk-group-name">For ${this.pageHost}</h3>
								<div class="tk-list">${here.map((skill) => this.renderSkillInfo(skill))}</div>
							</section>`
						: nothing
				}
				${this.renderGroups()}
				${
					this.searchQuery.trim() && here.length + elsewhere.length + bundled === 0
						? html`<p class="text-sm text-muted-foreground">No skill matches.</p>`
						: nothing
				}
				<section class="flex flex-col gap-2">
					${
						elsewhere.length > 0
							? html`<div class="tk-list" data-testid="site-skills">
									${this.opener(
										"group:site-skills",
										html`<span class="tk-row-name">Site skills</span>`,
										String(elsewhere.length),
										() =>
											html`<div class="tk-list-inner">${elsewhere.map((skill) => this.renderSkillInfo(skill))}</div>`,
										Boolean(this.searchQuery.trim()) ||
											elsewhere.some((s) => s.name === this.editingSkill?.name),
									)}
								</div>`
							: nothing
					}
					<p class="tk-group-note">
						Site skills are helpers the agent loads on the sites they name. Record one from More.
					</p>
					<div class="flex gap-2 px-3">
						${this.skills.length > 0 ? Button({ variant: "outline", size: "sm", onClick: () => this.exportSkills(), children: "Export" }) : nothing}
						${Button({ variant: "outline", size: "sm", onClick: () => this.importSkills(), children: "Import" })}
					</div>
				</section>
			</div>
		`;
	}
}

customElements.define("skills-tab", SkillsTab);
