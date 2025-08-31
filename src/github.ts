import { requestUrl, RequestUrlParam } from 'obsidian';

export interface GitHubRepo {
	name: string;
	full_name: string;
	owner: {
		login: string;
	};
	default_branch: string;
	private: boolean;
	fork: boolean;
	archived: boolean;
	clone_url: string;
}

export interface GitHubTreeItem {
	path: string;
	mode: string;
	type: 'blob' | 'tree';
	sha: string;
	size?: number;
	url: string;
}

export interface GitHubTree {
	sha: string;
	url: string;
	tree: GitHubTreeItem[];
	truncated: boolean;
}

export interface GitHubBlob {
	sha: string;
	content: string;
	encoding: 'base64' | 'utf-8';
	size: number;
}

export interface GitHubBranch {
	name: string;
	commit: {
		sha: string;
	};
}

export class GitHubAPI {
	private token: string;
	private baseUrl = 'https://api.github.com';

	constructor(token: string) {
		this.token = token;
	}

	private async request<T>(endpoint: string, options: Partial<RequestUrlParam> = {}): Promise<T> {
		const url = `${this.baseUrl}${endpoint}`;
		
		const requestOptions: RequestUrlParam = {
			url,
			method: 'GET',
			headers: {
				'Authorization': `token ${this.token}`,
				'Accept': 'application/vnd.github.v3+json',
				'User-Agent': 'obsidian-github-readme-sync'
			},
			...options
		};

		try {
			const response = await requestUrl(requestOptions);
			
			if (response.status >= 400) {
				throw new Error(`GitHub API request failed: ${response.status} ${response.text}`);
			}

			return response.json;
		} catch (error) {
			throw new Error(`GitHub API request failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async getUserRepos(username: string): Promise<GitHubRepo[]> {
		const repos: GitHubRepo[] = [];
		let page = 1;
		const perPage = 100;

		while (true) {
			const pageRepos = await this.request<GitHubRepo[]>(
				`/users/${username}/repos?per_page=${perPage}&page=${page}&sort=updated&direction=desc`
			);

			if (pageRepos.length === 0) {
				break;
			}

			repos.push(...pageRepos);
			
			if (pageRepos.length < perPage) {
				break;
			}

			page++;
		}

		return repos;
	}

	async getOrgRepos(org: string): Promise<GitHubRepo[]> {
		const repos: GitHubRepo[] = [];
		let page = 1;
		const perPage = 100;

		while (true) {
			const pageRepos = await this.request<GitHubRepo[]>(
				`/orgs/${org}/repos?per_page=${perPage}&page=${page}&sort=updated&direction=desc`
			);

			if (pageRepos.length === 0) {
				break;
			}

			repos.push(...pageRepos);
			
			if (pageRepos.length < perPage) {
				break;
			}

			page++;
		}

		return repos;
	}

	async getBranchSHA(owner: string, repo: string, branch: string): Promise<string> {
		const branchData = await this.request<GitHubBranch>(`/repos/${owner}/${repo}/branches/${branch}`);
		return branchData.commit.sha;
	}

	async getTree(owner: string, repo: string, sha: string, recursive = true): Promise<GitHubTree> {
		const recursiveParam = recursive ? '?recursive=1' : '';
		return await this.request<GitHubTree>(`/repos/${owner}/${repo}/git/trees/${sha}${recursiveParam}`);
	}

	async getBlob(owner: string, repo: string, sha: string): Promise<GitHubBlob> {
		return await this.request<GitHubBlob>(`/repos/${owner}/${repo}/git/blobs/${sha}`);
	}

	async getAllMarkdownFiles(owner: string, repo: string, branch = 'main'): Promise<GitHubTreeItem[]> {
		try {
			const branchSHA = await this.getBranchSHA(owner, repo, branch);
			const tree = await this.getTree(owner, repo, branchSHA, true);

			return tree.tree.filter(item => 
				item.type === 'blob' && 
				(item.path.endsWith('.md') || item.path.endsWith('.mdx'))
			);
		} catch (error) {
			throw new Error(`Failed to get markdown files for ${owner}/${repo}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async getAllSyncableFiles(owner: string, repo: string, branch = 'main', includeMedia = false): Promise<GitHubTreeItem[]> {
		try {
			const branchSHA = await this.getBranchSHA(owner, repo, branch);
			const tree = await this.getTree(owner, repo, branchSHA, true);

			return tree.tree.filter(item => {
				if (item.type !== 'blob') return false;
				
				// Always include markdown files
				if (item.path.endsWith('.md') || item.path.endsWith('.mdx')) {
					return true;
				}
				
				// Include media files if enabled
				if (includeMedia && this.isMediaFile(item.path)) {
					return true;
				}
				
				return false;
			});
		} catch (error) {
			throw new Error(`Failed to get files for ${owner}/${repo}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async getMarkdownFileContent(owner: string, repo: string, item: GitHubTreeItem): Promise<string> {
		try {
			const blob = await this.getBlob(owner, repo, item.sha);
			
			if (blob.encoding === 'base64') {
				return atob(blob.content);
			}
			
			return blob.content;
		} catch (error) {
			throw new Error(`Failed to get content for ${item.path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	isMarkdownFile(path: string): boolean {
		return path.endsWith('.md') || path.endsWith('.mdx');
	}

	isMediaFile(path: string): boolean {
		const mediaExtensions = [
			'.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico',
			'.mp4', '.mov', '.avi', '.webm', '.mp3', '.wav', '.pdf'
		];
		const ext = path.toLowerCase().substring(path.lastIndexOf('.'));
		return mediaExtensions.includes(ext);
	}

	async getFileContent(owner: string, repo: string, item: GitHubTreeItem): Promise<string | ArrayBuffer> {
		try {
			const blob = await this.getBlob(owner, repo, item.sha);
			
			if (blob.encoding === 'base64') {
				if (this.isMediaFile(item.path)) {
					// Return binary data for media files
					const binaryString = atob(blob.content);
					const bytes = new Uint8Array(binaryString.length);
					for (let i = 0; i < binaryString.length; i++) {
						bytes[i] = binaryString.charCodeAt(i);
					}
					return bytes.buffer;
				} else {
					// Return text content for markdown files
					return atob(blob.content);
				}
			}
			
			return blob.content;
		} catch (error) {
			throw new Error(`Failed to get content for ${item.path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	buildFileUrl(owner: string, repo: string, path: string, branch = 'main'): string {
		return `https://github.com/${owner}/${repo}/blob/${branch}/${path}`;
	}

	buildRepoUrl(owner: string, repo: string): string {
		return `https://github.com/${owner}/${repo}`;
	}

}