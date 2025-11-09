export interface FileMetadata {
	owner: string;
	repo: string;
	branch: string;
	path: string;
	githubUrl: string;
}

export function addFrontmatterIfMissing(content: string, metadata: FileMetadata): string {
	const { owner, repo, branch, path, githubUrl } = metadata;
	
	// Check if frontmatter already exists
	if (content.startsWith('---\n')) {
		return content;
	}

	const frontmatter = `---
github_repo: ${owner}/${repo}
github_path: ${path}
github_url: ${githubUrl}
synced_at: ${new Date().toISOString()}
readonly: true
---

`;

	return frontmatter + content;
}

export function addReadonlyBanner(content: string, metadata: FileMetadata): string {
	const { owner, repo, githubUrl } = metadata;

	const banner = `> [!WARNING] Read-Only
> This file is synced from GitHub. Any local changes will be overwritten.
> View source: [${owner}/${repo}](${githubUrl})

`;

	// If content already has frontmatter, add banner after it
	if (content.startsWith('---\n')) {
		const frontmatterEnd = content.indexOf('\n---\n') + 5;
		const frontmatter = content.substring(0, frontmatterEnd);
		const remainingContent = content.substring(frontmatterEnd);

		// Check if banner already exists
		if (remainingContent.includes('> [!WARNING] Read-Only')) {
			return content;
		}

		return frontmatter + banner + remainingContent;
	}

	// Check if banner already exists
	if (content.includes('> [!WARNING] Read-Only')) {
		return content;
	}

	return banner + content;
}

export function addBacklink(content: string, backLinkTarget: string): string {
	const backlink = `← [[${backLinkTarget}]]\n\n`;

	// Find where to insert the backlink (after frontmatter and/or read-only banner)
	let insertPosition = 0;

	// If content has frontmatter, skip past it
	if (content.startsWith('---\n')) {
		const frontmatterEnd = content.indexOf('\n---\n');
		if (frontmatterEnd !== -1) {
			insertPosition = frontmatterEnd + 5; // +5 to skip past "\n---\n"
		}
	}

	// If content has read-only banner after frontmatter, skip past it
	const remainingContent = content.substring(insertPosition);
	if (remainingContent.startsWith('> [!WARNING] Read-Only')) {
		const bannerEnd = remainingContent.indexOf('\n\n');
		if (bannerEnd !== -1) {
			insertPosition += bannerEnd + 2; // +2 to skip past "\n\n"
		}
	}

	// Check if backlink already exists (check for any backlink pattern, not specific target)
	const checkContent = content.substring(insertPosition);
	if (checkContent.match(/^← \[\[.*?\]\]\n\n/)) {
		return content;
	}

	// Insert backlink at the calculated position
	return content.substring(0, insertPosition) + backlink + content.substring(insertPosition);
}

export function processFileContent(content: string, metadata: FileMetadata, options: {
	addFrontmatter: boolean;
	addReadonlyBanner: boolean;
	addBacklinks: boolean;
	backlinkTarget?: string;
}): string {
	let processedContent = content;

	if (options.addFrontmatter) {
		processedContent = addFrontmatterIfMissing(processedContent, metadata);
	}

	if (options.addReadonlyBanner) {
		processedContent = addReadonlyBanner(processedContent, metadata);
	}

	if (options.addBacklinks && options.backlinkTarget) {
		processedContent = addBacklink(processedContent, options.backlinkTarget);
	}

	return processedContent;
}

export function stripSyncedContent(content: string): string {
	let strippedContent = content;

	// Remove frontmatter if it contains github_repo
	if (strippedContent.startsWith('---\n')) {
		const frontmatterEnd = strippedContent.indexOf('\n---\n');
		if (frontmatterEnd !== -1) {
			const frontmatter = strippedContent.substring(4, frontmatterEnd);
			if (frontmatter.includes('github_repo:')) {
				strippedContent = strippedContent.substring(frontmatterEnd + 5);
			}
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

	// Trim any leading whitespace that may have been left
	return strippedContent.trimStart();
}

export function extractGitHubMetadata(content: string): FileMetadata | null {
	if (!content.startsWith('---\n')) {
		return null;
	}

	const frontmatterEnd = content.indexOf('\n---\n');
	if (frontmatterEnd === -1) {
		return null;
	}

	const frontmatter = content.substring(4, frontmatterEnd);
	const lines = frontmatter.split('\n');
	
	let githubRepo = '';
	let githubPath = '';
	let githubUrl = '';

	for (const line of lines) {
		const [key, ...valueParts] = line.split(':');
		const value = valueParts.join(':').trim();
		
		switch (key.trim()) {
			case 'github_repo':
				githubRepo = value;
				break;
			case 'github_path':
				githubPath = value;
				break;
			case 'github_url':
				githubUrl = value;
				break;
		}
	}

	if (!githubRepo || !githubPath || !githubUrl) {
		return null;
	}

	const [owner, repo] = githubRepo.split('/');
	if (!owner || !repo) {
		return null;
	}

	// Extract branch from URL if possible (not always reliable, but try)
	const urlParts = githubUrl.split('/');
	const blobIndex = urlParts.findIndex(part => part === 'blob');
	const branch = blobIndex !== -1 && urlParts[blobIndex + 1] ? urlParts[blobIndex + 1] : 'main';

	return {
		owner,
		repo,
		branch,
		path: githubPath,
		githubUrl
	};
}