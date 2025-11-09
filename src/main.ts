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
		this.updateStatusBar('Ready');

		// Add command
		this.addCommand({
			id: 'sync-now',
			name: 'Sync Now',
			callback: () => this.syncAll()
		});

		// Setup auto-sync if enabled
		if (this.settings.autoSync && this.settings.syncIntervalHours > 0) {
			this.setupAutoSync();
		}

		console.log('GitHub Readme Sync plugin loaded');
	}

	onunload() {
		if (this.syncInterval) {
			window.clearInterval(this.syncInterval);
		}
		console.log('GitHub Readme Sync plugin unloaded');
	}

	async loadSettings() {
		const loadedData = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
		
		// Migration: convert old syncIntervalMinutes to syncIntervalHours
		if (loadedData && 'syncIntervalMinutes' in loadedData && !('syncIntervalHours' in loadedData)) {
			this.settings.syncIntervalHours = Math.max(0.1, (loadedData as any).syncIntervalMinutes / 60);
			await this.saveSettings();
			console.log(`Migrated sync interval from ${(loadedData as any).syncIntervalMinutes} minutes to ${this.settings.syncIntervalHours} hours`);
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
			await this.saveSettings();

			// Show completion message
			const message = errorCount === 0 
				? `Synced ${syncedCount} repositories`
				: `Synced ${syncedCount} repositories (${errorCount} errors)`;
			
			new Notice(message);
			this.updateStatusBar(`Complete: ${syncedCount} repos`);

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
				syncedFiles.add(this.getLocalFilePath(baseFolderPath, fileItem.path));
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
		const localFilePath = this.getLocalFilePath(baseFolderPath, fileItem.path);

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
			backlinkTarget = this.calculateBacklinkTarget(baseFolderPath, fileItem.path);
		}

		const processedContent = processFileContent(content, metadata, {
			addFrontmatter: this.settings.addFrontmatter,
			addReadonlyBanner: this.settings.addReadonlyBanner,
			addBacklinks: this.settings.addBacklinks,
			backlinkTarget: backlinkTarget
		});

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

	private getLocalFilePath(baseFolderPath: string, githubPath: string): string {
		return `${baseFolderPath}/${githubPath}`;
	}

	private calculateBacklinkTarget(baseFolderPath: string, filePath: string): string {
		// filePath examples: "README.md", "docs/README.md", "docs/guide/README.md"

		// Parse the directory path
		const pathParts = filePath.split('/');
		const fileName = pathParts.pop(); // Remove the filename

		// Check if this is a root-level README
		if (pathParts.length === 0) {
			// Root README links to base folder (e.g., "Projects")
			return this.settings.baseFolder;
		}

		// For nested READMEs, link to parent directory's README
		// Remove the last directory to get the parent
		pathParts.pop();

		// Build the backlink target
		if (pathParts.length === 0) {
			// Parent is the repo root (e.g., docs/README.md -> Projects/owner/repo/README)
			return `${baseFolderPath}/README`;
		} else {
			// Parent is another nested README (e.g., docs/guide/README.md -> Projects/owner/repo/docs/README)
			return `${baseFolderPath}/${pathParts.join('/')}/README`;
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
		console.log('Found existing folders:', existingRepoIds);
		
		// If we have more existing folders than our tracking suggests, clean up extras
		const untrackedExistingRepos = existingRepoIds.filter(repoId => !currentRepoIds.includes(repoId));
		if (untrackedExistingRepos.length > 0) {
			console.log('Migration: Found untracked repos to clean up:', untrackedExistingRepos);
			removedRepoIds = [...removedRepoIds, ...untrackedExistingRepos];
		}

		console.log('Cleanup debug:');
		console.log('Previous repos:', previousRepoIds);
		console.log('Current repos:', currentRepoIds);
		console.log('Removed repos:', removedRepoIds);

		if (removedRepoIds.length === 0) {
			return;
		}

		console.log(`Cleaning up ${removedRepoIds.length} removed repositories:`, removedRepoIds);

		for (const repoId of removedRepoIds) {
			const [owner, repo] = repoId.split('/');
			if (!owner || !repo) continue;

			const repoFolderPath = `${this.settings.baseFolder}/${owner}/${repo}`;
			const repoFolder = this.app.vault.getAbstractFileByPath(repoFolderPath);

			if (repoFolder && repoFolder instanceof TFolder) {
				try {
					await this.recursiveDeleteFolder(repoFolder);
					console.log(`Deleted repository folder: ${repoFolderPath}`);
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
					console.log(`Deleted empty owner folder: ${ownerFolderPath}`);
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

		console.log('Scanned existing repositories:', existingRepoIds);
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
}