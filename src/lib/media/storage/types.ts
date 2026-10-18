export interface Storage {
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  /**
   * Stores a local file under `key`, streaming it: the file is never loaded into memory. Use this
   * for media; `put` is for small objects.
   */
  putFile(key: string, filePath: string, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /**
   * Copies the object under `key` to a local file, streaming it: the object is never loaded into
   * memory. Use this for media. Fails like `get` when the key does not exist, and leaves no partial
   * file behind when the copy fails.
   */
  getFile(key: string, destPath: string): Promise<void>;
  delete(key: string): Promise<void>;
  getSignedUrl(key: string, expiresInSeconds?: number): Promise<string>;
}
