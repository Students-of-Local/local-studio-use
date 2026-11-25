/** What the service worker hears when a side panel thread is saved, renamed or deleted. */
export const THREAD_CHANGED = "local-studio-thread-changed";
/** The worker asks the panel that shows a chat to put in what the Local Studio app added (src/threads/sync.ts). */
export const CHAT_MERGE = "local-studio-chat-merge";
/** A panel asks the worker for the app's own threads, or for one of them. */
export const APP_THREADS = "local-studio-app-threads";
