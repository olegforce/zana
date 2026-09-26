import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { LibraryDoc } from '@zana-ai/zcc-domain/product';
import { useCompactLayout } from '../../../hooks/useCompactLayout.js';
import './mobile-library.css';

/** Keep the tree mounted so returning from a mobile document preserves its filters and folders. */
export function useLibraryNavigation() {
  const compact = useCompactLayout();
  const [selectedDoc, setSelection] = useState<LibraryDoc | null>(null);
  const [readerOpen, setReaderOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const treeScroll = useRef(0);
  const restoringTree = useRef(false);

  const setSelectedDoc = useCallback((doc: LibraryDoc | null) => {
    const tree = rootRef.current?.querySelector<HTMLElement>('.library-tree');
    if (tree && !tree.closest('[hidden]')) treeScroll.current = tree.scrollTop;
    setSelection(doc);
    setReaderOpen(doc !== null);
  }, []);

  const backToDocuments = useCallback(() => {
    restoringTree.current = true;
    setReaderOpen(false);
  }, []);

  useLayoutEffect(() => {
    if (!compact) return;
    if (readerOpen) {
      backRef.current?.focus({ preventScroll: true });
    } else if (restoringTree.current) {
      const tree = rootRef.current?.querySelector<HTMLElement>('.library-tree');
      if (tree) tree.scrollTop = treeScroll.current;
      rootRef.current?.querySelector<HTMLElement>('.tree-row.file.active')?.focus({ preventScroll: true });
      restoringTree.current = false;
    }
  }, [compact, readerOpen]);

  return { compact, selectedDoc, setSelectedDoc, readerOpen, backToDocuments, rootRef, backRef };
}
