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

/**
 * Resolve a relative path from the current file's directory.
 * Examples:
 *   resolvePath("docs/guide.md", "./api.md") -> "docs/api.md"
 *   resolvePath("docs/guide.md", "../README.md") -> "README.md"
 *   resolvePath("README.md", "./docs/guide.md") -> "docs/guide.md"
 */
function resolvePath(currentFilePath: string, relativePath: string): string {
	// Get the directory of the current file
	const pathParts = currentFilePath.split('/');
	pathParts.pop(); // Remove filename

	// Handle the relative path
	const relParts = relativePath.split('/');

	for (const part of relParts) {
		if (part === '.' || part === '') {
			continue;
		} else if (part === '..') {
			pathParts.pop();
		} else {
			pathParts.push(part);
		}
	}

	return pathParts.join('/');
}

/**
 * Convert relative markdown links to Obsidian wikilinks.
 *
 * Examples:
 *   [Guide](./docs/guide.md) -> [[guide]]
 *   [API Reference](../api.md#endpoints) -> [[api#endpoints|API Reference]]
 *   [External](https://example.com) -> unchanged
 */
export function rewriteMarkdownLinks(
	content: string,
	currentFilePath: string,
	renameReadmes: boolean,
	repo: string
): string {
	// Pattern: [text](path) but NOT ![text](path) (images) and NOT external URLs
	// Captures: 1=link text, 2=path (possibly with anchor)
	const linkPattern = /(?<!!)\[([^\]]+)\]\((?!https?:\/\/)(?!#)([^)]+)\)/g;

	return content.replace(linkPattern, (match, linkText: string, linkPath: string) => {
		// Skip if path doesn't look like a markdown file reference
		// (could be an anchor-only link or something else)
		if (!linkPath.includes('.md') && !linkPath.includes('#')) {
			return match;
		}

		// Separate the path and anchor
		let targetPath = linkPath;
		let anchor = '';

		if (linkPath.includes('#')) {
			const hashIndex = linkPath.indexOf('#');
			targetPath = linkPath.substring(0, hashIndex);
			anchor = linkPath.substring(hashIndex);
		}

		// If it's just an anchor (same-file link), keep as wikilink
		if (!targetPath) {
			return `[[${anchor}|${linkText}]]`;
		}

		// Skip non-markdown files
		if (!targetPath.endsWith('.md')) {
			return match;
		}

		// Resolve the relative path
		const resolvedPath = resolvePath(currentFilePath, targetPath);

		// Get just the filename without extension
		let filename = resolvedPath.split('/').pop() || '';
		filename = filename.replace(/\.md$/, '');

		// Handle README renaming if enabled
		if (renameReadmes && filename.toLowerCase() === 'readme') {
			// Get the folder name for the README
			const resolvedParts = resolvedPath.split('/');
			resolvedParts.pop(); // Remove README.md

			if (resolvedParts.length === 0) {
				// Root README - use repo name
				filename = repo;
			} else {
				// Nested README - use folder name
				filename = resolvedParts[resolvedParts.length - 1];
			}
		}

		// Build the wikilink
		const target = filename + anchor;

		// Use alias if link text differs from filename (case-insensitive)
		if (linkText.toLowerCase() === filename.toLowerCase()) {
			return `[[${target}]]`;
		}

		return `[[${target}|${linkText}]]`;
	});
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

	// Replace existing backlink if present, or insert new one
	const checkContent = content.substring(insertPosition);
	const existingBacklinkMatch = checkContent.match(/^← \[\[.*?\]\]\n\n/);
	if (existingBacklinkMatch) {
		// Replace existing backlink with new one
		return content.substring(0, insertPosition) + backlink + checkContent.substring(existingBacklinkMatch[0].length);
	}

	// Insert new backlink at the calculated position
	return content.substring(0, insertPosition) + backlink + content.substring(insertPosition);
}

export function processFileContent(content: string, metadata: FileMetadata, options: {
	addFrontmatter: boolean;
	addReadonlyBanner: boolean;
	addBacklinks: boolean;
	backlinkTarget?: string;
	convertLinks: boolean;
	renameReadmes: boolean;
}): string {
	let processedContent = content;

	// Convert markdown links to wikilinks first (before adding other content)
	if (options.convertLinks) {
		processedContent = rewriteMarkdownLinks(
			processedContent,
			metadata.path,
			options.renameReadmes,
			metadata.repo
		);
	}

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