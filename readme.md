



This works just like Rsync.

Client connects using Websocket to the server on specific path.

Client sends request for status of file via websocket.
- If the file does not exists, then it is uploaded in whole via ws.
- If the file does exist but the size differ, then the SHA256 is computed and returned back to the client to verify.
- If the SHA256 differ then the client will chunk up the file to fixed size blocks, calculated based on file size (square root of size)
  - Each chunk has two hashes, SHA1 and CRC32, the hashes with offset and size is sent to the server via ws.
  - Server loads the file that it has locally and scans the file with window size of the block size set by client. 
    The scan starts with offset of 0 and +1 for every pass. For each chunk the server calculates CRC32 hash and compares it to the fingerprint sent by client.
  - If the CRC32 matches then SHA1 is calculated and compare, if that matches then we can mark that chunk as found.
  - Server calculates what chunks are missing and requests the client to send missing chunks.
  - Client slices the missing buffer from the file and send's them to the server.
  - Server constructs new file from the chunks and computes SHA256 to check if file matches.
  - Server sends complete and client disconnects.
