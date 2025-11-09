import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import GitHubReadmeSyncPlugin from './main';

export interface AutoDefaults {
	includePrivate: boolean;
	includeForks: boolean;
	includeArchived: boolean;
	repoGlob: string;
}

export interface ManualRepo {
	owner: string;
	repo: string;
	branch?: string;
}

export interface GitHubReadmeSyncSettings {
	githubToken: string;
	namespaces: string[];
	autoDefaults: AutoDefaults;
	repos: ManualRepo[];
	syncIntervalHours: number;
	autoSync: boolean;
	addFrontmatter: boolean;
	addReadonlyBanner: boolean;
	addBacklinks: boolean;
	renameReadmesToFolderNames: boolean;
	pruneExtraneousFiles: boolean;
	baseFolder: string;
	syncMediaFiles: boolean;
	lastSyncedRepos: string[]; // Track previously synced repos for cleanup
	lastSyncTime: number | null; // Unix timestamp in milliseconds of last successful sync
}

export const DEFAULT_SETTINGS: GitHubReadmeSyncSettings = {
	githubToken: '',
	namespaces: [],
	autoDefaults: {
		includePrivate: false,
		includeForks: false,
		includeArchived: false,
		repoGlob: '*'
	},
	repos: [],
	syncIntervalHours: 1,
	autoSync: false,
	addFrontmatter: true,
	addReadonlyBanner: true,
	addBacklinks: true,
	renameReadmesToFolderNames: true,
	pruneExtraneousFiles: false,
	baseFolder: 'Projects',
	syncMediaFiles: false,
	lastSyncedRepos: [],
	lastSyncTime: null
};

export class GitHubReadmeSyncSettingTab extends PluginSettingTab {
	plugin: GitHubReadmeSyncPlugin;

	constructor(app: App, plugin: GitHubReadmeSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('GitHub Personal Access Token')
			.setDesc('Required for accessing GitHub API. Needs "public_repo" scope (or "repo" for private repos). Create at: https://github.com/settings/tokens')
			.addText(text => text
				.setPlaceholder('ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')
				.setValue(this.plugin.settings.githubToken)
				.onChange(async (value) => {
					this.plugin.settings.githubToken = value;
					await this.plugin.saveSettings();
				}));

		// Add sync now button
		new Setting(containerEl)
			.setName('Manual Sync')
			.setDesc('Sync all configured repositories now')
			.addButton(button => button
				.setButtonText('Sync Now')
				.setCta()
				.onClick(async () => {
					button.setButtonText('Syncing...');
					button.setDisabled(true);
					try {
						await this.plugin.syncAll();
						button.setButtonText('Sync Now');
					} catch (error) {
						button.setButtonText('Error - Try Again');
						setTimeout(() => {
							button.setButtonText('Sync Now');
						}, 3000);
					}
					button.setDisabled(false);
				}));

		new Setting(containerEl)
			.setName('Base folder')
			.setDesc('Folder in vault where repositories will be synced')
			.addText(text => text
				.setPlaceholder('Projects')
				.setValue(this.plugin.settings.baseFolder)
				.onChange(async (value) => {
					this.plugin.settings.baseFolder = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'Auto-Discovery' });
		containerEl.createEl('p', { 
			text: 'Automatically sync ALL repositories from your GitHub account(s). Add your GitHub username below to get started.',
			cls: 'setting-item-description'
		});

		new Setting(containerEl)
			.setName('Your GitHub username')
			.setDesc('Your GitHub username (e.g., "octocat")')
			.addText(text => text
				.setPlaceholder('yourusername')
				.setValue(this.plugin.settings.namespaces[0] || '')
				.onChange(async (value) => {
					if (value.trim()) {
						this.plugin.settings.namespaces = [value.trim()];
					} else {
						this.plugin.settings.namespaces = [];
					}
					await this.plugin.saveSettings();
				}));

		if (this.plugin.settings.namespaces.length > 0) {
			containerEl.createEl('h4', { text: 'Repository Filters' });
			containerEl.createEl('p', { 
				text: 'Choose which types of repositories to sync:',
				cls: 'setting-item-description'
			});

			new Setting(containerEl)
				.setName('Include private repositories')
				.setDesc('Sync your private repositories (requires "repo" token scope)')
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.autoDefaults.includePrivate)
					.onChange(async (value) => {
						this.plugin.settings.autoDefaults.includePrivate = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('Include forked repositories')
				.setDesc('Sync repositories you\'ve forked from others')
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.autoDefaults.includeForks)
					.onChange(async (value) => {
						this.plugin.settings.autoDefaults.includeForks = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('Include archived repositories')
				.setDesc('Sync archived/read-only repositories')
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.autoDefaults.includeArchived)
					.onChange(async (value) => {
						this.plugin.settings.autoDefaults.includeArchived = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('Repository name filter (optional)')
				.setDesc('Only sync repos matching this pattern. Use * for all, or patterns like "my-*" or "*-docs"')
				.addText(text => text
					.setPlaceholder('* (all repositories)')
					.setValue(this.plugin.settings.autoDefaults.repoGlob)
					.onChange(async (value) => {
						this.plugin.settings.autoDefaults.repoGlob = value || '*';
						await this.plugin.saveSettings();
					}));
		}

		containerEl.createEl('h3', { text: 'Manual Repositories' });

		new Setting(containerEl)
			.setName('Manual repositories')
			.setDesc('Specific repositories to sync (one per line: owner/repo or owner/repo@branch)')
			.addTextArea(text => {
				const textArea = text
					.setPlaceholder('microsoft/typescript\nfacebook/react@main\noctocat/my-project@develop')
					.setValue(this.plugin.settings.repos.map(repo => 
						repo.branch && repo.branch !== 'main' 
							? `${repo.owner}/${repo.repo}@${repo.branch}`
							: `${repo.owner}/${repo.repo}`
					).join('\n'))
					.onChange(async (value) => {
						const repos = value.split('\n')
							.map(line => line.trim())
							.filter(line => line.length > 0)
							.map(line => {
								const [repoPath, branch] = line.split('@');
								const [owner, repo] = repoPath.split('/');
								if (owner && repo) {
									return { owner, repo, branch: branch || 'main' };
								}
								return null;
							})
							.filter(repo => repo !== null) as ManualRepo[];
						
						this.plugin.settings.repos = repos;
						await this.plugin.saveSettings();
					});
				textArea.inputEl.rows = 6;
				textArea.inputEl.style.fontFamily = 'monospace';
				return textArea;
			});

		containerEl.createEl('h3', { text: 'Sync Options' });

		new Setting(containerEl)
			.setName('Auto-sync')
			.setDesc('Automatically sync repositories at regular intervals')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoSync)
				.onChange(async (value) => {
					this.plugin.settings.autoSync = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sync interval (hours)')
			.setDesc('Hours between automatic syncs (if enabled)')
			.addText(text => text
				.setPlaceholder('1')
				.setValue(this.plugin.settings.syncIntervalHours.toString())
				.onChange(async (value) => {
					const hours = parseFloat(value);
					if (!isNaN(hours) && hours > 0) {
						this.plugin.settings.syncIntervalHours = hours;
						await this.plugin.saveSettings();
					}
				}));

		// Sync Status section
		if (this.plugin.settings.autoSync) {
			containerEl.createEl('h4', { text: 'Sync Status', cls: 'setting-item-heading' });

			// Last sync time
			const lastSyncDesc = this.plugin.settings.lastSyncTime
				? this.plugin.formatTimeAgo(this.plugin.settings.lastSyncTime)
				: 'Never';

			new Setting(containerEl)
				.setName('Last sync')
				.setDesc(lastSyncDesc);

			// Next sync time and progress
			if (this.plugin.settings.lastSyncTime) {
				const timeUntilNext = this.plugin.getTimeUntilNextSync();
				const nextSyncDesc = timeUntilNext !== null && timeUntilNext > 0
					? 'in ' + this.plugin.formatRelativeTime(timeUntilNext)
					: 'Overdue (will sync on next open)';

				new Setting(containerEl)
					.setName('Next sync')
					.setDesc(nextSyncDesc);

				// Progress bar
				const intervalMs = this.plugin.settings.syncIntervalHours * 60 * 60 * 1000;
				const elapsedMs = Date.now() - this.plugin.settings.lastSyncTime;
				const progressPercent = Math.min(100, (elapsedMs / intervalMs) * 100);

				new Setting(containerEl)
					.setName('Progress to next sync')
					.addProgressBar(progress => progress.setValue(progressPercent));
			}
		}

		containerEl.createEl('h3', { text: 'File Processing' });

		new Setting(containerEl)
			.setName('Add frontmatter')
			.setDesc('Add GitHub metadata to synced files')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.addFrontmatter)
				.onChange(async (value) => {
					this.plugin.settings.addFrontmatter = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Add read-only banner')
			.setDesc('Add warning banner marking files as read-only')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.addReadonlyBanner)
				.onChange(async (value) => {
					this.plugin.settings.addReadonlyBanner = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Rename READMEs to folder names')
			.setDesc('Rename README.md files to their folder names for better graph view. Root README uses repo name, nested READMEs use folder name.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.renameReadmesToFolderNames)
				.onChange(async (value) => {
					this.plugin.settings.renameReadmesToFolderNames = value;
					await this.plugin.saveSettings();
					// Trigger immediate re-sync to rename/restore files
					new Notice(`Syncing to ${value ? 'rename' : 'restore'} README files...`);
					try {
						await this.plugin.syncAll();
						new Notice(`README files ${value ? 'renamed' : 'restored'} successfully!`);
					} catch (error) {
						new Notice(`Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
					}
				}));

		containerEl.createEl('h3', { text: 'Navigation' });

		new Setting(containerEl)
			.setName('Add backlinks')
			.setDesc('Add hierarchical backlinks for graph view. Root READMEs link to base folder, nested READMEs link to parent README.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.addBacklinks)
				.onChange(async (value) => {
					this.plugin.settings.addBacklinks = value;
					await this.plugin.saveSettings();
					// Trigger immediate re-sync to update all files
					new Notice(`Syncing to ${value ? 'add' : 'remove'} backlinks...`);
					try {
						await this.plugin.syncAll();
						new Notice(`Backlinks ${value ? 'added' : 'removed'} successfully!`);
					} catch (error) {
						new Notice(`Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
					}
				}));

		containerEl.createEl('h3', { text: 'Additional Options' });

		new Setting(containerEl)
			.setName('Sync media files')
			.setDesc('Sync images, GIFs, and other media files (png, jpg, gif, svg, webp, etc.)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncMediaFiles)
				.onChange(async (value) => {
					this.plugin.settings.syncMediaFiles = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Prune extraneous files')
			.setDesc('Remove files that no longer exist in source repositories')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.pruneExtraneousFiles)
				.onChange(async (value) => {
					this.plugin.settings.pruneExtraneousFiles = value;
					await this.plugin.saveSettings();
				}));
	}
}