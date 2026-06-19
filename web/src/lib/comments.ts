// Per-cell comment threads (a JSON sidecar on the server; never in the .ipynb).

export interface CommentT {
  id: string;
  cell_id: string;
  author: string;
  text: string;
  created_at: string;
}

// A lightweight author identity kept in localStorage (no auth in this app).
export function getAuthor(): string {
  try {
    return localStorage.getItem("nbclone_author") || "you";
  } catch {
    return "you";
  }
}

export async function listComments(
  notebookId: string,
): Promise<Record<string, CommentT[]>> {
  const r = await fetch(`/api/contents/${encodeURIComponent(notebookId)}/comments`);
  if (!r.ok) throw new Error(`load comments failed: ${r.status}`);
  return r.json();
}

export async function addComment(
  notebookId: string,
  cellId: string,
  author: string,
  text: string,
): Promise<CommentT> {
  const r = await fetch(`/api/contents/${encodeURIComponent(notebookId)}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cell_id: cellId, author, text }),
  });
  if (!r.ok) throw new Error(`add comment failed: ${r.status}`);
  return r.json();
}

export async function deleteComment(
  notebookId: string,
  commentId: string,
): Promise<void> {
  const r = await fetch(
    `/api/contents/${encodeURIComponent(notebookId)}/comments/${commentId}`,
    { method: "DELETE" },
  );
  if (!r.ok) throw new Error(`delete comment failed: ${r.status}`);
}
