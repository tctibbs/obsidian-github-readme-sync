import { Notice, Plugin, TFile, TFolder } from 'obsidian';
import { GitHubAPI, GitHubRepo, GitHubTreeItem } from './github';
import { processFileContent, FileMetadata, extractGitHubMetadata } from './linkRewrite';
import { GitHubReadmeSyncSettings, DEFAULT_SETTINGS, GitHubReadmeSyncSettingTab, AutoDefaults } from './settings';
import * as micromatch from 'micromatch';

interface RepoConfig {
	owner: string;
	repo: string;
	branch: string;
	source: 'auto' | 'manual';
}

export default class GitHubReadmeSyncPlugin extends Plugin {
	settings!: GitHubReadmeSyncSettings;
	private github: GitHubAPI | null = null;
	private syncInterval: number | null = null;
	private statusBarItem!: HTMLElement;

	async onload() {
		await this.loadSettings();

		// Add settings tab
		this.addSettingTab(new GitHubReadmeSyncSettingTab(this.app, this));

		// Add status bar item
		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBarWithCountdown();

		// Add command
		this.addCommand({
			id: 'sync-now',
			name: 'Sync Now',
			callback: () => this.syncAll()
		});

		// Setup auto-sync if enabled
		if (this.settings.autoSync && this.settings.syncIntervalHours > 0) {
			// Check if a sync is overdue (e.g., Obsidian was closed during interval)
			if (this.settings.lastSyncTime) {
				const elapsedMs = Date.now() - this.settings.lastSyncTime;
				const intervalMs = this.settings.syncIntervalHours * 60 * 60 * 1000;

				if (elapsedMs >= intervalMs) {
					// Don't await - let it run in background
					this.syncAll();
				}
			}

			this.setupAutoSync();
		}
	}

	onunload() {
		if (this.syncInterval) {
			window.clearInterval(this.syncInterval);
		}
	}

	async loadSettings() {
		const loadedData = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
		
		// Migration: convert old syncIntervalMinutes to syncIntervalHours
		if (loadedData && 'syncIntervalMinutes' in loadedData) {
			if (!('syncIntervalHours' in loadedData)) {
				this.settings.syncIntervalHours = Math.max(0.1, (loadedData as any).syncIntervalMinutes / 60);
			}
			// Clean up old field
			delete (this.settings as any).syncIntervalMinutes;
			await this.saveSettings();
		}
		
		// Initialize GitHub API if token is available
		if (this.settings.githubToken) {
			this.github = new GitHubAPI(this.settings.githubToken);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
		
		// Reinitialize GitHub API if token changed
		if (this.settings.githubToken) {
			this.github = new GitHubAPI(this.settings.githubToken);
		} else {
			this.github = null;
		}

		// Update auto-sync
		if (this.settings.autoSync && this.settings.syncIntervalHours > 0) {
			this.setupAutoSync();
		} else if (this.syncInterval) {
			window.clearInterval(this.syncInterval);
			this.syncInterval = null;
		}
	}

	private setupAutoSync() {
		if (this.syncInterval) {
			window.clearInterval(this.syncInterval);
		}

		this.syncInterval = window.setInterval(() => {
			this.syncAll();
		}, this.settings.syncIntervalHours * 60 * 60 * 1000);
	}

	private updateStatusBar(status: string) {
		this.statusBarItem.setText(`GitHub Sync: ${status}`);
	}

	private updateStatusBarWithCountdown() {
		// Update status bar with countdown
		if (this.settings.autoSync && this.settings.lastSyncTime) {
			const timeUntilNext = this.getTimeUntilNextSync();
			if (timeUntilNext !== null && timeUntilNext > 0) {
				const formattedTime = this.formatRelativeTime(timeUntilNext);
				this.updateStatusBar(`Next in ${formattedTime}`);
			} else {
				this.updateStatusBar('Sync overdue');
			}
		} else {
			this.updateStatusBar('Ready');
		}
	}

	async syncAll() {
		if (!this.github) {
			new Notice('GitHub token not configured');
			return;
		}

		this.updateStatusBar('Syncing...');

		try {
			// Get all repositories to sync
			const repoConfigs = await this.getAllRepoConfigs();
			
			if (repoConfigs.length === 0) {
				new Notice('No repositories configured for sync');
				this.updateStatusBar('No repos configured');
				return;
			}

			// Clean up repositories that are no longer being synced
			const currentRepoIds = repoConfigs.map(config => `${config.owner}/${config.repo}`);
			await this.cleanupRemovedRepositories(currentRepoIds);

			let syncedCount = 0;
			let errorCount = 0;

			// Sync each repository
			for (const repoConfig of repoConfigs) {
				try {
					await this.syncRepository(repoConfig);
					syncedCount++;
				} catch (error) {
					console.error(`Failed to sync ${repoConfig.owner}/${repoConfig.repo}:`, error);
					errorCount++;
				}
			}

			// Update the list of synced repositories for future cleanup
			this.settings.lastSyncedRepos = currentRepoIds;
			// Save timestamp of successful sync
			this.settings.lastSyncTime = Date.now();
			await this.saveSettings();

			// Show completion message
			const message = errorCount === 0
				? `Synced ${syncedCount} repositories`
				: `Synced ${syncedCount} repositories (${errorCount} errors)`;

			new Notice(message);
			this.updateStatusBarWithCountdown();

		} catch (error) {
			console.error('Sync failed:', error);
			new Notice(`Sync failed: ${error instanceof Error ? error.message : String(error)}`);
			this.updateStatusBar('Error');
		}
	}

	private async getAllRepoConfigs(): Promise<RepoConfig[]> {
		const configs: RepoConfig[] = [];

		// Add manual repositories
		for (const manualRepo of this.settings.repos) {
			configs.push({
				owner: manualRepo.owner,
				repo: manualRepo.repo,
				branch: manualRepo.branch || 'main',
				source: 'manual'
			});
		}

		// Add auto-discovered repositories
		if (this.settings.namespaces.length > 0) {
			const autoRepos = await this.discoverRepositories();
			for (const repo of autoRepos) {
				// Avoid duplicates from manual config
				const exists = configs.some(config => 
					config.owner === repo.owner.login && config.repo === repo.name
				);

				if (!exists) {
					configs.push({
						owner: repo.owner.login,
						repo: repo.name,
						branch: repo.default_branch,
						source: 'auto'
					});
				}
			}
		}

		return configs;
	}

	private async discoverRepositories(): Promise<GitHubRepo[]> {
		if (!this.github) {
			return [];
		}

		const allRepos: GitHubRepo[] = [];

		for (const namespace of this.settings.namespaces) {
			try {
				// Try as user first, then as organization
				let repos: GitHubRepo[] = [];
				
				try {
					repos = await this.github.getUserRepos(namespace);
				} catch (error) {
					// If user repos fail, try org repos
					try {
						repos = await this.github.getOrgRepos(namespace);
					} catch (orgError) {
						console.error(`Failed to get repos for ${namespace}:`, orgError instanceof Error ? orgError.message : String(orgError));
						continue;
					}
				}

				if (repos.length === 0) {
					continue;
				}

				// Apply filters
				const filteredRepos = this.filterRepositories(repos, this.settings.autoDefaults);
				allRepos.push(...filteredRepos);

			} catch (error) {
				console.error(`Failed to discover repos for ${namespace}:`, error instanceof Error ? error.message : String(error));
			}
		}

		return allRepos;
	}

	private filterRepositories(repos: GitHubRepo[], filters: AutoDefaults): GitHubRepo[] {
		return repos.filter(repo => {
			// Filter by private status
			if (!filters.includePrivate && repo.private) {
				return false;
			}

			// Filter by archived status
			if (!filters.includeArchived && repo.archived) {
				return false;
			}

			// Filter by fork status
			if (!filters.includeForks && repo.fork) {
				return false;
			}

			// Filter by name glob pattern
			if (filters.repoGlob && filters.repoGlob !== '*') {
				if (!micromatch.isMatch(repo.name, filters.repoGlob)) {
					return false;
				}
			}

			return true;
		});
	}

	private async syncRepository(repoConfig: RepoConfig) {
		if (!this.github) {
			throw new Error('GitHub API not initialized');
		}

		const { owner, repo, branch } = repoConfig;

		// Get all syncable files from repository (markdown + optional media)
		const syncableFiles = await this.github.getAllSyncableFiles(owner, repo, branch, this.settings.syncMediaFiles);
		
		if (syncableFiles.length === 0) {
			return;
		}

		// Create base folder structure
		const baseFolderPath = `${this.settings.baseFolder}/${owner}/${repo}`;
		await this.ensureFolderExists(baseFolderPath);

		// Track synced files for pruning
		const syncedFiles = new Set<string>();

		// Sync each file
		for (const fileItem of syncableFiles) {
			try {
				await this.syncFile(owner, repo, branch, fileItem, baseFolderPath);
				syncedFiles.add(this.getLocalFilePath(baseFolderPath, fileItem.path, repo));
			} catch (error) {
				console.error(`Failed to sync ${fileItem.path}:`, error);
			}
		}

		// Prune extraneous files if enabled
		if (this.settings.pruneExtraneousFiles) {
			await this.pruneExtraneousFiles(baseFolderPath, syncedFiles);
		}
	}

	private async syncFile(owner: string, repo: string, branch: string, fileItem: GitHubTreeItem, baseFolderPath: string) {
		if (!this.github) {
			return;
		}

		// Get file content from GitHub
		const content = await this.github.getFileContent(owner, repo, fileItem);

		// Determine local file path
		const localFilePath = this.getLocalFilePath(baseFolderPath, fileItem.path, repo);
		const oldFilePath = `${baseFolderPath}/${fileItem.path}`; // Original path without renaming

		// Ensure parent folder exists
		const parentPath = localFilePath.substring(0, localFilePath.lastIndexOf('/'));
		await this.ensureFolderExists(parentPath);

		// Handle binary files (media)
		if (content instanceof ArrayBuffer) {
			const existingFile = this.app.vault.getAbstractFileByPath(localFilePath);
			
			if (existingFile) {
				await this.app.vault.modifyBinary(existingFile as TFile, content);
			} else {
				await this.app.vault.createBinary(localFilePath, content);
			}
			return;
		}

		// Handle text files (markdown) with metadata processing
		const metadata: FileMetadata = {
			owner,
			repo,
			branch,
			path: fileItem.path,
			githubUrl: this.github.buildFileUrl(owner, repo, fileItem.path, branch)
		};

		// Calculate hierarchical backlink target
		let backlinkTarget: string | undefined;
		if (this.settings.addBacklinks) {
			backlinkTarget = this.calculateBacklinkTarget(baseFolderPath, fileItem.path, repo);
		}

		const processedContent = processFileContent(content, metadata, {
			addFrontmatter: this.settings.addFrontmatter,
			addReadonlyBanner: this.settings.addReadonlyBanner,
			addBacklinks: this.settings.addBacklinks,
			backlinkTarget: backlinkTarget,
			convertLinks: this.settings.convertLinksToWikilinks,
			renameReadmes: this.settings.renameReadmesToFolderNames
		});

		// Handle file migration if renaming is enabled
		const oldFile = this.app.vault.getAbstractFileByPath(oldFilePath);
		const newFile = this.app.vault.getAbstractFileByPath(localFilePath);

		// If renaming is enabled and old file exists at different path, migrate it
		if (this.settings.renameReadmesToFolderNames &&
			oldFilePath !== localFilePath &&
			oldFile instanceof TFile &&
			!newFile) {
			// Rename old file to new location
			await this.app.vault.rename(oldFile, localFilePath);
		}

		// Check if file needs updating
		const existingFile = this.app.vault.getAbstractFileByPath(localFilePath);
		let shouldUpdate = true;

		if (existingFile && existingFile instanceof TFile) {
			const existingContent = await this.app.vault.read(existingFile);

			// Compare the processed content to see if anything changed
			// This will detect both GitHub content changes AND processing option changes
			shouldUpdate = processedContent !== existingContent;
		}

		if (shouldUpdate) {
			if (existingFile) {
				await this.app.vault.modify(existingFile as TFile, processedContent);
			} else {
				await this.app.vault.create(localFilePath, processedContent);
			}
		}
	}

	private getLocalFilePath(baseFolderPath: string, githubPath: string, repo?: string): string {
		// Check if renaming is enabled and this is a README file
		if (this.settings.renameReadmesToFolderNames && this.isReadmeFile(githubPath)) {
			const renamedPath = this.getRenamedReadmePath(githubPath, repo);
			return `${baseFolderPath}/${renamedPath}`;
		}
		return `${baseFolderPath}/${githubPath}`;
	}

	private isReadmeFile(path: string): boolean {
		const filename = path.split('/').pop()?.toLowerCase() || '';
		return filename === 'readme.md';
	}

	private getRenamedReadmePath(githubPath: string, repo?: string): string {
		const pathParts = githubPath.split('/');
		const filename = pathParts.pop(); // Remove README.md

		if (pathParts.length === 0) {
			// Root README - use repo name
			return repo ? `${repo}.md` : 'README.md';
		}

		// Nested README - use folder name
		const folderName = pathParts[pathParts.length - 1];
		return `${pathParts.join('/')}/${folderName}.md`;
	}

	private calculateBacklinkTarget(baseFolderPath: string, filePath: string, repo?: string): string {
		// filePath examples: "README.md", "docs/README.md", "agents/backend-architect.md"
		// Strategy: Always link to repo root README to guarantee valid links
		// This creates a hub-and-spoke pattern where all files connect to the main README

		const pathParts = filePath.split('/');
		pathParts.pop(); // Remove the filename

		// Root-level files link to base folder
		if (pathParts.length === 0) {
			return this.settings.baseFolder;
		}

		// All nested files link to repo root README
		// This ensures backlinks are always valid (no broken links to missing parent READMEs)
		if (this.settings.renameReadmesToFolderNames && repo) {
			return repo;
		} else {
			return 'README';
		}
	}

	private stripProcessedContent(content: string): string {
		let strippedContent = content;

		// Remove frontmatter
		if (strippedContent.startsWith('---\n')) {
			const frontmatterEnd = strippedContent.indexOf('\n---\n');
			if (frontmatterEnd !== -1) {
				strippedContent = strippedContent.substring(frontmatterEnd + 5);
			}
		}

		// Remove read-only banner
		const bannerStart = strippedContent.indexOf('> [!WARNING] Read-Only');
		if (bannerStart !== -1) {
			const bannerEnd = strippedContent.indexOf('\n\n', bannerStart);
			if (bannerEnd !== -1) {
				strippedContent = strippedContent.substring(0, bannerStart) + strippedContent.substring(bannerEnd + 2);
			}
		}

		// Remove backlink (matches pattern: ← [[anything]]\n\n)
		const backlinkPattern = /^← \[\[.*?\]\]\n\n/;
		strippedContent = strippedContent.replace(backlinkPattern, '');

		return strippedContent.trimStart();
	}

	private async ensureFolderExists(path: string) {
		const folders = path.split('/');
		let currentPath = '';

		for (const folder of folders) {
			if (!folder) continue;
			
			currentPath = currentPath ? `${currentPath}/${folder}` : folder;
			
			const existingFolder = this.app.vault.getAbstractFileByPath(currentPath);
			if (!existingFolder) {
				await this.app.vault.createFolder(currentPath);
			}
		}
	}

	private async pruneExtraneousFiles(baseFolderPath: string, syncedFiles: Set<string>) {
		const baseFolder = this.app.vault.getAbstractFileByPath(baseFolderPath);
		if (!baseFolder || !(baseFolder instanceof TFolder)) {
			return;
		}

		await this.pruneFolder(baseFolder, syncedFiles);
	}

	private async pruneFolder(folder: TFolder, syncedFiles: Set<string>) {
		const filesToDelete: TFile[] = [];
		const foldersToCheck: TFolder[] = [];

		for (const child of folder.children) {
			if (child instanceof TFile) {
				// Check if this file was synced from GitHub and is no longer in the repo
				if (!syncedFiles.has(child.path)) {
					const isMarkdown = child.path.endsWith('.md') || child.path.endsWith('.mdx');
					const isMedia = this.github?.isMediaFile(child.path) || false;
					
					if (isMarkdown) {
						// For markdown files, check frontmatter
						const content = await this.app.vault.read(child);
						const metadata = extractGitHubMetadata(content);
						
						if (metadata) {
							// This was a synced markdown file that's no longer in the repo
							filesToDelete.push(child);
						}
					} else if (isMedia) {
						// For media files, assume they were synced if they're in a synced folder structure
						// This is a heuristic since media files don't have frontmatter
						const pathParts = child.path.split('/');
						if (pathParts.length >= 3 && pathParts[0] === this.settings.baseFolder) {
							filesToDelete.push(child);
						}
					}
				}
			} else if (child instanceof TFolder) {
				foldersToCheck.push(child);
			}
		}

		// Delete files
		for (const file of filesToDelete) {
			await this.app.vault.delete(file);
		}

		// Recursively check subfolders
		for (const subfolder of foldersToCheck) {
			await this.pruneFolder(subfolder, syncedFiles);
			
			// Delete empty folders
			if (subfolder.children.length === 0) {
				await this.app.vault.delete(subfolder);
			}
		}
	}

	private async cleanupRemovedRepositories(currentRepoIds: string[]) {
		const previousRepoIds = this.settings.lastSyncedRepos || [];
		let removedRepoIds = previousRepoIds.filter(repoId => !currentRepoIds.includes(repoId));

		// Migration: scan existing folders if we have fewer tracked than current filters suggest
		const existingRepoIds = await this.scanExistingRepositories();
		
		// If we have more existing folders than our tracking suggests, clean up extras
		const untrackedExistingRepos = existingRepoIds.filter(repoId => !currentRepoIds.includes(repoId));
		if (untrackedExistingRepos.length > 0) {
			removedRepoIds = [...removedRepoIds, ...untrackedExistingRepos];
		}

		if (removedRepoIds.length === 0) {
			return;
		}

		for (const repoId of removedRepoIds) {
			const [owner, repo] = repoId.split('/');
			if (!owner || !repo) continue;

			const repoFolderPath = `${this.settings.baseFolder}/${owner}/${repo}`;
			const repoFolder = this.app.vault.getAbstractFileByPath(repoFolderPath);

			if (repoFolder && repoFolder instanceof TFolder) {
				try {
					await this.recursiveDeleteFolder(repoFolder);
				} catch (error) {
					console.error(`Failed to delete repository folder ${repoFolderPath}:`, error);
				}
			}

			// Clean up empty owner folder if it's now empty
			const ownerFolderPath = `${this.settings.baseFolder}/${owner}`;
			const ownerFolder = this.app.vault.getAbstractFileByPath(ownerFolderPath);
			
			if (ownerFolder && ownerFolder instanceof TFolder && ownerFolder.children.length === 0) {
				try {
					await this.app.vault.delete(ownerFolder);
				} catch (error) {
					console.error(`Failed to delete owner folder ${ownerFolderPath}:`, error);
				}
			}
		}

		if (removedRepoIds.length > 0) {
			new Notice(`Cleaned up ${removedRepoIds.length} removed repositories`);
		}
	}

	private async scanExistingRepositories(): Promise<string[]> {
		const baseFolder = this.app.vault.getAbstractFileByPath(this.settings.baseFolder);
		if (!baseFolder || !(baseFolder instanceof TFolder)) {
			return [];
		}

		const existingRepoIds: string[] = [];

		// Scan owner folders (e.g., Projects/tctibbs/)
		for (const ownerChild of baseFolder.children) {
			if (!(ownerChild instanceof TFolder)) continue;
			
			const owner = ownerChild.name;

			// Scan repo folders (e.g., Projects/tctibbs/neural-noodle/)
			for (const repoChild of ownerChild.children) {
				if (!(repoChild instanceof TFolder)) continue;

				const repo = repoChild.name;
				existingRepoIds.push(`${owner}/${repo}`);
			}
		}

		return existingRepoIds;
	}

	private async recursiveDeleteFolder(folder: TFolder) {
		// Delete all files in the folder first
		for (const child of [...folder.children]) {
			if (child instanceof TFile) {
				await this.app.vault.delete(child);
			} else if (child instanceof TFolder) {
				await this.recursiveDeleteFolder(child);
			}
		}

		// Now delete the empty folder
		await this.app.vault.delete(folder);
	}

	getTimeSinceLastSync(): number | null {
		if (!this.settings.lastSyncTime) {
			return null;
		}
		return Date.now() - this.settings.lastSyncTime;
	}

	getTimeUntilNextSync(): number | null {
		if (!this.settings.lastSyncTime || !this.settings.autoSync) {
			return null;
		}
		const intervalMs = this.settings.syncIntervalHours * 60 * 60 * 1000;
		const elapsedMs = Date.now() - this.settings.lastSyncTime;
		const remainingMs = intervalMs - elapsedMs;
		return remainingMs > 0 ? remainingMs : 0;
	}

	formatRelativeTime(ms: number): string {
		const seconds = Math.floor(ms / 1000);
		const minutes = Math.floor(seconds / 60);
		const hours = Math.floor(minutes / 60);
		const days = Math.floor(hours / 24);

		if (days > 0) {
			return `${days}d ${hours % 24}h`;
		} else if (hours > 0) {
			return `${hours}h ${minutes % 60}m`;
		} else if (minutes > 0) {
			return `${minutes}m`;
		} else {
			return `${seconds}s`;
		}
	}

	formatTimeAgo(timestamp: number): string {
		const ms = Date.now() - timestamp;
		return this.formatRelativeTime(ms) + ' ago';
	}
}