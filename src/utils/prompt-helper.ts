import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * Reads a markdown file and properly escapes it for use as a system prompt
 * Handles backticks, code blocks, and other markdown syntax that could interfere with template literals
 * 
 * @param promptPath - Path to the markdown file relative to src/prompts/
 * @returns Properly escaped content ready for use in template literals
 */
export function getSystemPrompt(promptPath: string = 'prompt.md'): string {
  try {
    // Try multiple possible paths to find the prompt file
    const possiblePaths = [
      // Path from current working directory
      join(process.cwd(), 'src', 'prompts', promptPath),
      // Path from project root (if cwd is different)
      join(process.cwd(), '..', 'src', 'prompts', promptPath),
      // Path from utils directory
      join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts', promptPath),
      // Absolute path fallback
      join('/Users/nikolastanin/Desktop/bonusesai/bonusesai-agent/src/prompts', promptPath)
    ];
    
    let content = '';
    let foundPath = '';
    
    for (const fullPath of possiblePaths) {
      try {
        content = readFileSync(fullPath, 'utf-8');
        foundPath = fullPath;
        console.log(`✅ Found prompt file at: ${fullPath}`);
        break;
      } catch (err) {
        // Continue to next path
        continue;
      }
    }
    
    if (!content) {
      throw new Error(`Prompt file not found in any of the attempted paths: ${possiblePaths.join(', ')}`);
    }
    
    // Escape the content for use in template literals
    return escapeForTemplateLiteral(content);
  } catch (error) {
    console.error(`Error reading prompt file ${promptPath}:`, error);
    throw new Error(`Failed to read prompt file: ${promptPath}`);
  }
}

/**
 * Escapes content for safe use in template literals
 * Handles backticks, dollar signs, and other characters that have special meaning in template literals
 * 
 * @param content - The content to escape
 * @returns Escaped content safe for template literals
 */
function escapeForTemplateLiteral(content: string): string {
  return content
    // Escape backticks by replacing them with \`
    .replace(/`/g, '\\`')
    // Escape dollar signs followed by curly braces to prevent template literal interpolation
    .replace(/\$\{/g, '\\${')
    // Escape backslashes that aren't already escaping something
    .replace(/(?<!\\)\\(?!`|\$)/g, '\\\\');
}
