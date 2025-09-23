import { Client } from 'pg';
import { openai } from '@ai-sdk/openai';
import { generateEmbedding } from 'ai';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

interface DocumentData {
  id: string;
  text: string;
  metadata?: Record<string, any>;
}

class DocumentInserter {
  private client: Client;

  constructor() {
    this.client = new Client({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME || 'mastra',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'password',
    });
  }

  async connect() {
    try {
      await this.client.connect();
      console.log('Connected to PostgreSQL database');
    } catch (error) {
      console.error('Error connecting to database:', error);
      throw error;
    }
  }

  async disconnect() {
    await this.client.end();
    console.log('Disconnected from database');
  }

  async generateEmbedding(text: string): Promise<number[]> {
    try {
      const { embedding } = await generateEmbedding({
        model: openai.embedding('text-embedding-3-small'),
        value: text,
      });
      return embedding;
    } catch (error) {
      console.error('Error generating embedding:', error);
      throw error;
    }
  }

  async insertDocument(document: DocumentData): Promise<void> {
    try {
      // Generate embedding for the text
      console.log('Generating embedding for document:', document.id);
      const embedding = await this.generateEmbedding(document.text);

      // Insert into database
      const query = `
        INSERT INTO mastra_vectors (id, text, metadata, embedding, indexed_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (id) DO UPDATE SET
          text = EXCLUDED.text,
          metadata = EXCLUDED.metadata,
          embedding = EXCLUDED.embedding,
          indexed_at = NOW()
      `;

      await this.client.query(query, [
        document.id,
        document.text,
        JSON.stringify(document.metadata || {}),
        `[${embedding.join(',')}]` // Convert array to PostgreSQL vector format
      ]);

      console.log(`Successfully inserted document: ${document.id}`);
    } catch (error) {
      console.error('Error inserting document:', error);
      throw error;
    }
  }

  async insertMultipleDocuments(documents: DocumentData[]): Promise<void> {
    console.log(`Inserting ${documents.length} documents...`);
    
    for (const document of documents) {
      await this.insertDocument(document);
    }
    
    console.log('All documents inserted successfully');
  }
}

// Example usage
async function main() {
  const inserter = new DocumentInserter();
  
  try {
    await inserter.connect();

    // Example documents to insert
    const documents: DocumentData[] = [
      {
        id: 'doc-1',
        text: 'This is a sample document about artificial intelligence and machine learning.',
        metadata: {
          category: 'technology',
          author: 'AI Assistant',
          tags: ['AI', 'ML', 'technology']
        }
      },
      {
        id: 'doc-2',
        text: 'PostgreSQL is a powerful open-source relational database management system.',
        metadata: {
          category: 'database',
          author: 'Database Expert',
          tags: ['PostgreSQL', 'database', 'SQL']
        }
      },
      {
        id: 'doc-3',
        text: 'Vector embeddings are numerical representations of text that capture semantic meaning.',
        metadata: {
          category: 'AI',
          author: 'ML Engineer',
          tags: ['embeddings', 'vectors', 'semantic']
        }
      }
    ];

    // Insert documents
    await inserter.insertMultipleDocuments(documents);

  } catch (error) {
    console.error('Error in main:', error);
  } finally {
    await inserter.disconnect();
  }
}

// Run the script if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { DocumentInserter, DocumentData };
