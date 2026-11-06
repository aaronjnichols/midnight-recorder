import { rename } from "node:fs/promises";

// Windows can refuse a rename for a short time while another program, for
// example a virus scanner, reads the new file. Try again for about 4
// seconds. Other errors fail at once.
export async function replaceFile(from, to, renameFile = rename) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await renameFile(from, to);
    } catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 12)
        throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(50 * 2 ** attempt, 400)),
      );
    }
  }
}
