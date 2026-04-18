export interface CommandHelpSpec {
  name: string;
  aliases?: string[];
  summary: string;
  usage?: string[];
  examples?: string[];
  notes?: string[];
}

export interface ThreadBrowserItem {
  index: number;
  threadId: string;
  title: string | null;
  preview: string | null;
  updatedAt: number | null;
  isCurrent: boolean;
  alias: string | null;
}

export interface ThreadBrowserPageState {
  providerProfileId: string;
  searchTerm: string | null;
  nextCursor: string | null;
  previousCursors: string[];
  items: ThreadBrowserItem[];
  updatedAt: number;
}
