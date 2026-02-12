import "obsidian";

declare module "obsidian" {
	interface WorkspaceLeaf {
		id: string;
		working: boolean;
		parentSplit: WorkspaceSplit;
	}

	interface WorkspaceSplit {
		children: WorkspaceLeaf[];
		parentSplit: WorkspaceSplit | null;
	}
}
