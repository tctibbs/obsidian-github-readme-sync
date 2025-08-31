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

export function processFileContent(content: string, metadata: FileMetadata, options: {
	addFrontmatter: boolean;
	addReadonlyBanner: boolean;
}): string {
	let processedContent = content;

	if (options.addFrontmatter) {
		processedContent = addFrontmatterIfMissing(processedContent, metadata);
	}

	if (options.addReadonlyBanner) {
		processedContent = addReadonlyBanner(processedContent, metadata);
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