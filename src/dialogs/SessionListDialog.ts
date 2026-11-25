import i18n from "@mariozechner/mini-lit/dist/i18n.js";
import { getAppStorage, type SessionData, type SessionMetadata } from "@mariozechner/pi-web-ui";
import Fuse from "fuse.js";
import { html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Download, FileDown, FileUp, Pencil, Trash2 } from "lucide";
import "../components/HeaderMenu.js";
import type { HeaderMenuItem } from "../components/HeaderMenu.js";
import { PageBase } from "../components/PageBase.js";
import { Toast } from "../components/Toast.js";
import { type AppThread, appThreads, folderName, inOrder, unopened } from "../threads/app-threads.js";

type ExportedSession = {
	session: SessionData;
	metadata: SessionMetadata;
};

@customElement("local-studio-session-list-dialog")
export class LocalStudioSessionListDialog extends PageBase {
	@state() private sessions: SessionMetadata[] = [];
	@state() private loading = true;
	@state() private searchQuery = "";
	/** The Local Studio app's own threads that match the search. */
	@state() private threads: AppThread[] = [];
	private threadSearch?: ReturnType<typeof setTimeout>;
	/** The row whose title is being edited in place. */
	@state() private renamingId?: string;

	private onSelectCallback?: (sessionId: string) => void;
	private onDeleteCallback?: (sessionId: string) => void;
	private onRenameCallback?: (sessionId: string, title: string) => void;
	private onThreadCallback?: (thread: AppThread) => void;
	private currentId?: string;
	private deletedSessions = new Set<string>();
	private closedViaSelection = false;

	protected override fillsHeight = true;

	static async open(
		onSelect: (sessionId: string) => void,
		onDelete?: (sessionId: string) => void,
		onRename?: (sessionId: string, title: string) => void,
		currentId?: string,
		onThread?: (thread: AppThread) => void,
	) {
		const dialog = new LocalStudioSessionListDialog();
		dialog.onSelectCallback = onSelect;
		dialog.onDeleteCallback = onDelete;
		dialog.onRenameCallback = onRename;
		dialog.currentId = currentId;
		dialog.onThreadCallback = onThread;
		dialog.open();
		// Typing finds a chat at once; Enter opens the top match.
		await dialog.updateComplete;
		dialog.querySelector<HTMLInputElement>("input[type=search]")?.focus();
		await Promise.all([dialog.loadSessions(), dialog.loadThreads()]);
	}

	private async loadThreads() {
		const query = this.searchQuery;
		const threads = this.onThreadCallback ? await appThreads(query) : [];
		if (query === this.searchQuery) this.threads = threads;
	}

	private handleThread(thread: AppThread) {
		this.closedViaSelection = true;
		this.onThreadCallback?.(thread);
		this.close();
	}

	private async loadSessions() {
		this.loading = true;
		try {
			// Load sessions (already sorted by lastModified index)
			const storage = getAppStorage();
			this.sessions = await storage.sessions.getAllMetadata();
		} catch (err) {
			console.error("Failed to load sessions:", err);
			this.sessions = [];
		} finally {
			this.loading = false;
		}
	}

	/** Deletes at once and offers Undo, instead of a browser confirm box for every chat. */
	private async handleDelete(sessionId: string) {
		try {
			const storage = getAppStorage();
			if (!storage.sessions) return;
			const data = await storage.sessions.loadSession(sessionId);
			const metadata = this.sessions.find((s) => s.id === sessionId);
			await storage.sessions.deleteSession(sessionId);
			this.deletedSessions.add(sessionId);
			await this.loadSessions();
			const title = metadata?.title || i18n("Untitled chat");
			Toast.show(i18n("Deleted “{title}”").replace("{title}", title), "info", 8000, {
				label: i18n("Undo"),
				run: () => {
					if (!data || !metadata) return;
					void storage.sessions
						.save(data, metadata)
						.then(() => {
							this.deletedSessions.delete(sessionId);
							return this.loadSessions();
						})
						.catch((err) => console.error("Failed to restore session:", err));
				},
			});
		} catch (err) {
			console.error("Failed to delete session:", err);
			Toast.error(i18n("Could not delete the chat"));
		}
	}

	private async saveRename(sessionId: string, value: string) {
		const title = value.trim();
		this.renamingId = undefined;
		const current = this.sessions.find((s) => s.id === sessionId);
		if (!title || !current || title === current.title) return;
		try {
			await getAppStorage().sessions.updateTitle(sessionId, title);
			await this.loadSessions();
			this.onRenameCallback?.(sessionId, title);
		} catch (err) {
			console.error("Failed to rename session:", err);
			Toast.error(i18n("Could not rename the chat"));
		}
	}

	private async startRename(sessionId: string) {
		this.renamingId = sessionId;
		await this.updateComplete;
		const input = this.querySelector<HTMLInputElement>(
			`[data-session="${CSS.escape(sessionId)}"] input[data-rename]`,
		);
		input?.focus();
		input?.select();
	}

	override close() {
		super.close();

		// Only notify about deleted sessions if dialog wasn't closed via selection
		if (!this.closedViaSelection && this.onDeleteCallback && this.deletedSessions.size > 0) {
			for (const sessionId of this.deletedSessions) {
				this.onDeleteCallback(sessionId);
			}
		}
	}

	private handleSelect(sessionId: string) {
		this.closedViaSelection = true;
		if (this.onSelectCallback) {
			this.onSelectCallback(sessionId);
		}
		this.close();
	}

	/** "now", "5m", "3h", "2d", then the date, as the app's own list says it. */
	private when(isoString: string): string {
		const minutes = Math.floor((Date.now() - Date.parse(isoString)) / 60_000);
		if (minutes < 1) return i18n("now");
		if (minutes < 60) return `${minutes}m`;
		if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
		if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / (24 * 60))}d`;
		return new Date(isoString).toLocaleDateString(undefined, { month: "short", day: "numeric" });
	}

	private async handleExport(sessionId?: string) {
		try {
			const storage = getAppStorage();
			if (!storage.sessions) return;

			const exported: ExportedSession[] = [];

			if (sessionId) {
				// Export single session
				const session = await storage.sessions.loadSession(sessionId);
				const metadata = this.sessions.find((s) => s.id === sessionId);
				if (session && metadata) {
					exported.push({ session, metadata });
				}
			} else {
				// Export all sessions
				for (const metadata of this.sessions) {
					const session = await storage.sessions.loadSession(metadata.id);
					if (session) {
						exported.push({ session, metadata });
					}
				}
			}

			// Always export as array
			const blob = new Blob([JSON.stringify(exported, null, 2)], {
				type: "application/json",
			});
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			const filename = sessionId
				? `local-studio-session-${exported[0]?.metadata.title?.replace(/[^a-z0-9]/gi, "-").toLowerCase() || "export"}.json`
				: `local-studio-sessions-${new Date().toISOString().split("T")[0]}.json`;
			a.download = filename;
			a.click();
			URL.revokeObjectURL(url);
		} catch (err) {
			console.error("Failed to export sessions:", err);
			alert(i18n("Export failed. Check console for details."));
		}
	}

	private getFilteredSessions(): SessionMetadata[] {
		if (!this.searchQuery.trim()) {
			return this.sessions;
		}

		// Use Fuse.js for fuzzy search
		const fuse = new Fuse(this.sessions, {
			keys: ["title", "preview"],
			threshold: 0.4, // 0 = exact match, 1 = match anything
			ignoreLocation: true,
			minMatchCharLength: 2,
		});

		const results = fuse.search(this.searchQuery);
		return results.map((result) => result.item);
	}

	private async handleDeleteAll() {
		if (this.sessions.length === 0) {
			alert(i18n("No sessions to delete"));
			return;
		}

		const confirmed = confirm(
			i18n(`Delete ALL {count} sessions? This cannot be undone!`).replace(
				"{count}",
				this.sessions.length.toString(),
			),
		);

		if (!confirmed) return;

		try {
			const storage = getAppStorage();
			if (!storage.sessions) return;

			for (const session of this.sessions) {
				await storage.sessions.deleteSession(session.id);
				this.deletedSessions.add(session.id);
			}

			await this.loadSessions();
		} catch (err) {
			console.error("Failed to delete all sessions:", err);
			alert(i18n("Failed to delete sessions. Check console for details."));
		}
	}

	private async handleDeleteOlderThan(days: number) {
		const cutoffDate = new Date();
		cutoffDate.setDate(cutoffDate.getDate() - days);
		const cutoffISO = cutoffDate.toISOString();

		const oldSessions = this.sessions.filter((s) => s.lastModified < cutoffISO);

		if (oldSessions.length === 0) {
			alert(i18n(`No sessions older than {days} days`).replace("{days}", days.toString()));
			return;
		}

		const confirmed = confirm(
			i18n(`Delete {count} sessions older than {days} days?`)
				.replace("{count}", oldSessions.length.toString())
				.replace("{days}", days.toString()),
		);

		if (!confirmed) return;

		try {
			const storage = getAppStorage();
			if (!storage.sessions) return;

			for (const session of oldSessions) {
				await storage.sessions.deleteSession(session.id);
				this.deletedSessions.add(session.id);
			}

			await this.loadSessions();
		} catch (err) {
			console.error("Failed to delete old sessions:", err);
			alert(i18n("Failed to delete sessions. Check console for details."));
		}
	}

	private async handleImport() {
		try {
			const input = document.createElement("input");
			input.type = "file";
			input.accept = "application/json";
			input.onchange = async (e: Event) => {
				const file = (e.target as HTMLInputElement).files?.[0];
				if (!file) return;

				const text = await file.text();
				const importData = JSON.parse(text);

				// Import expects array of ExportedSession
				const sessionsToImport: ExportedSession[] = importData;

				// Validate format
				if (!sessionsToImport.every((s) => s.session && s.metadata)) {
					alert(i18n("Invalid import file format"));
					return;
				}

				const storage = getAppStorage();
				if (!storage.sessions) return;

				// Check for duplicates
				const existingIds = new Set(this.sessions.map((s) => s.id));
				const duplicates = sessionsToImport.filter((s) => existingIds.has(s.metadata.id));

				let duplicateAction: "skip" | "overwrite" | null = null;
				if (duplicates.length > 0) {
					const choice = confirm(
						i18n(`Found {count} duplicate sessions. Click OK to overwrite, Cancel to skip duplicates.`).replace(
							"{count}",
							duplicates.length.toString(),
						),
					);
					duplicateAction = choice ? "overwrite" : "skip";
				}

				let imported = 0;
				let skipped = 0;

				// Set import time to now, with offsets to preserve order
				const baseTime = new Date();

				for (let i = 0; i < sessionsToImport.length; i++) {
					const { session, metadata } = sessionsToImport[i];
					try {
						const isDuplicate = existingIds.has(metadata.id);

						if (isDuplicate && duplicateAction === "skip") {
							skipped++;
							continue;
						}

						// Set timestamps to now with offset based on position
						// First session gets most recent time, subsequent ones get older
						const offsetSeconds = i * 10; // 10 second intervals
						const importTime = new Date(baseTime.getTime() - offsetSeconds * 1000);
						const importTimeISO = importTime.toISOString();

						// Update metadata timestamps
						const updatedMetadata = {
							...metadata,
							lastModified: importTimeISO,
							createdAt: importTimeISO,
						};

						// Save with updated metadata
						await storage.sessions.save(session, updatedMetadata);
						imported++;
					} catch (err) {
						console.error(`Failed to import session ${metadata.title}:`, err);
					}
				}

				const message =
					skipped > 0
						? i18n(`Imported {imported} sessions, skipped {skipped} duplicates`)
								.replace("{imported}", imported.toString())
								.replace("{skipped}", skipped.toString())
						: i18n(`Imported {count} sessions`).replace("{count}", imported.toString());

				alert(message);
				await this.loadSessions();
			};
			input.click();
		} catch (err) {
			console.error("Failed to import sessions:", err);
			alert(i18n("Import failed. Check console for details."));
		}
	}

	private menuItems(): HeaderMenuItem[] {
		return [
			{ label: i18n("Import chats"), icon: FileUp, run: () => this.handleImport() },
			{ label: i18n("Export all chats"), icon: FileDown, run: () => this.handleExport() },
			{
				label: i18n("Delete chats older than 30 days"),
				icon: Trash2,
				separator: true,
				run: () => this.handleDeleteOlderThan(30),
			},
			{ label: i18n("Delete chats older than 90 days"), icon: Trash2, run: () => this.handleDeleteOlderThan(90) },
			{ label: i18n("Delete all chats"), icon: Trash2, run: () => this.handleDeleteAll() },
		];
	}

	private renderOpen(title: string, meta: string, time: string, tip: string, open: () => void): TemplateResult {
		return html`<button type="button" class="tk-chat-open" title=${tip} @click=${open}>
			<span class="tk-chat-line">
				<span class="tk-chat-title">${title}</span>
				<span class="tk-chat-time">${time}</span>
			</span>
			${meta ? html`<span class="tk-chat-meta">${meta}</span>` : nothing}
		</button>`;
	}

	/** A thread of the app's: opening it goes on from there in the panel, so it has no actions of its own. */
	private renderThread(thread: AppThread) {
		const meta = [i18n("In the app"), folderName(thread.folder)].filter(Boolean).join(" · ");
		return html`<li data-thread=${thread.id} class="tk-chat">
			${this.renderOpen(thread.title, meta, this.when(thread.modified), thread.title, () => this.handleThread(thread))}
		</li>`;
	}

	private rowMenu(session: SessionMetadata): HeaderMenuItem[] {
		return [
			{ label: i18n("Rename"), icon: Pencil, run: () => void this.startRename(session.id) },
			{ label: i18n("Export"), icon: Download, run: () => void this.handleExport(session.id) },
			{ label: i18n("Delete"), icon: Trash2, separator: true, run: () => void this.handleDelete(session.id) },
		];
	}

	private renderRow(session: SessionMetadata) {
		const cost = session.usage.cost.total;
		const current = session.id === this.currentId;
		const title = session.title || i18n("Untitled chat");
		const tip = [
			title,
			`${session.messageCount} ${i18n("messages")}`,
			cost > 0 ? `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}` : "",
		]
			.filter(Boolean)
			.join(" · ");
		// A title says which chat; its first message shows only as what a search found, and only where it adds to the title.
		const preview = (session.preview ?? "").trim();
		const meta = this.searchQuery.trim() && !preview.startsWith(title.replace(/(…|\.{3})$/, "")) ? preview : "";
		if (this.renamingId === session.id)
			return html`<li data-session=${session.id} class="tk-chat">
				<input
					data-rename
					type="text"
					aria-label=${i18n("Chat name")}
					.value=${session.title}
					class="tk-search m-1"
					@keydown=${(e: KeyboardEvent) => {
						if (e.key === "Enter") void this.saveRename(session.id, (e.target as HTMLInputElement).value);
						else if (e.key === "Escape") {
							e.preventDefault();
							e.stopPropagation();
							this.renamingId = undefined;
						}
					}}
					@blur=${(e: FocusEvent) => void this.saveRename(session.id, (e.target as HTMLInputElement).value)}
				/>
			</li>`;
		return html`<li data-session=${session.id} class="tk-chat" aria-current=${current ? "true" : nothing}>
			${this.renderOpen(title, meta, current ? i18n("Open now") : this.when(session.lastModified), tip, () =>
				this.handleSelect(session.id),
			)}
			<tk-header-menu class="tk-chat-menu" .items=${this.rowMenu(session)} label=${`${i18n("Actions for")} ${title}`}></tk-header-menu>
		</li>`;
	}

	protected override pageTitle(): string {
		return i18n("Past chats");
	}

	protected override pageActions(): TemplateResult {
		return html`<tk-header-menu .items=${this.menuItems()} label=${i18n("More actions")}></tk-header-menu>`;
	}

	protected override renderContent(): TemplateResult {
		const filteredSessions = this.getFilteredSessions();
		const threads = unopened(this.threads, this.sessions);
		// A search keeps its best match first; without one, everything is by time.
		const rows = this.searchQuery.trim()
			? [...filteredSessions.map((chat) => ({ chat })), ...threads.map((thread) => ({ thread }))]
			: inOrder(filteredSessions, threads);

		return html`
			<div class="tk-page-body min-h-0 flex-1 overflow-y-auto">
				<div class="mx-auto flex max-w-2xl flex-col gap-3 px-4 py-4">
					<input
						type="search"
						aria-label=${i18n("Search chats")}
						placeholder=${i18n("Search chats")}
						.value=${this.searchQuery}
						@input=${(e: InputEvent) => {
							this.searchQuery = (e.target as HTMLInputElement).value;
							clearTimeout(this.threadSearch);
							this.threadSearch = setTimeout(() => void this.loadThreads(), 200);
						}}
						@keydown=${(e: KeyboardEvent) => {
							if (e.key === "Enter" && !e.isComposing) {
								const top = this.getFilteredSessions()[0];
								if (top) this.handleSelect(top.id);
								else if (threads[0]) this.handleThread(threads[0]);
							} else if (e.key === "ArrowDown") {
								e.preventDefault();
								this.querySelector<HTMLElement>("li[data-session] button, li[data-thread] button")?.focus();
							}
						}}
						class="tk-search"
					/>
					<ul aria-label=${i18n("Past chats")}>
					${
						this.loading
							? nothing
							: rows.length === 0
								? html`<li class="py-8 text-center text-sm text-muted-foreground">
										${this.searchQuery ? i18n("No matching chats") : i18n("No chats yet")}
									</li>`
								: rows.map((row) => ("chat" in row ? this.renderRow(row.chat) : this.renderThread(row.thread)))
					}
					</ul>
				</div>
			</div>
		`;
	}
}
