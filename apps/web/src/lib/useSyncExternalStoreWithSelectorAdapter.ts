// FILE: useSyncExternalStoreWithSelectorAdapter.ts
// Purpose: Keeps React external in the embed build without a browser-side CommonJS require.
// Layer: Embed build adapter

import {
  useDebugValue,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore as reactUseSyncExternalStore,
} from "react";

export const useSyncExternalStore = reactUseSyncExternalStore;

export function useSyncExternalStoreWithSelector<Snapshot, Selection>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => Snapshot,
  getServerSnapshot: (() => Snapshot) | undefined,
  selector: (snapshot: Snapshot) => Selection,
  isEqual?: (left: Selection, right: Selection) => boolean,
): Selection {
  const instRef = useRef<{ hasValue: boolean; value: Selection | null } | null>(null);
  if (instRef.current === null) {
    instRef.current = { hasValue: false, value: null };
  }
  const inst = instRef.current;

  const [getSelection, getServerSelection] = useMemo(() => {
    let hasMemo = false;
    let memoizedSnapshot: Snapshot;
    let memoizedSelection: Selection;

    const memoizedSelector = (nextSnapshot: Snapshot): Selection => {
      if (!hasMemo) {
        hasMemo = true;
        memoizedSnapshot = nextSnapshot;
        const nextSelection = selector(nextSnapshot);
        if (isEqual && inst.hasValue && isEqual(inst.value as Selection, nextSelection)) {
          memoizedSelection = inst.value as Selection;
          return memoizedSelection;
        }
        memoizedSelection = nextSelection;
        return nextSelection;
      }

      const currentSelection = memoizedSelection;
      if (Object.is(memoizedSnapshot, nextSnapshot)) return currentSelection;

      const nextSelection = selector(nextSnapshot);
      if (isEqual?.(currentSelection, nextSelection)) {
        memoizedSnapshot = nextSnapshot;
        return currentSelection;
      }
      memoizedSnapshot = nextSnapshot;
      memoizedSelection = nextSelection;
      return nextSelection;
    };

    return [
      () => memoizedSelector(getSnapshot()),
      getServerSnapshot ? () => memoizedSelector(getServerSnapshot()) : undefined,
    ] as const;
  }, [getSnapshot, getServerSnapshot, selector, isEqual, inst]);

  const value = reactUseSyncExternalStore(subscribe, getSelection, getServerSelection);
  useEffect(() => {
    inst.hasValue = true;
    inst.value = value;
  }, [inst, value]);
  useDebugValue(value);
  return value;
}

export default { useSyncExternalStore, useSyncExternalStoreWithSelector };
