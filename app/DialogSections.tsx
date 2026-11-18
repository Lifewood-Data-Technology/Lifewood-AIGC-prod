"use client";
import { Children, Fragment, isValidElement, useRef, type ReactNode } from "react";

import useDialogFocus from "./useDialogFocus";

/** Keep callers’ forms, native dialogs and guarded close actions. */
export default function DialogSections({ children }: { children: ReactNode }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  useDialogFocus(bodyRef);
  const header: ReactNode[] = [], toolbar: ReactNode[] = [], body: ReactNode[] = [], footer: ReactNode[] = [];
  const collect = (nodes: ReactNode, path = "dialog") => {
    Children.forEach(nodes, (node, index) => {
      if (node == null || typeof node === "boolean") return;
      if (isValidElement<{ children?: ReactNode; "data-dialog-toolbar"?: boolean; "data-dialog-footer"?: boolean }>(node)) {
        if (node.type === Fragment) { collect(node.props.children, `${path}.${index}`); return; }
        const target = node.type === "header" ? header : node.type === "footer" || node.props["data-dialog-footer"] ? footer : node.props["data-dialog-toolbar"] ? toolbar : body;
        target.push(<Fragment key={`${path}.${node.key ?? index}`}>{node}</Fragment>);
      } else body.push(node);
    });
  };
  collect(children);
  return <>{header}{toolbar}<div ref={bodyRef} className="dialog-scroll-body">{body}</div>{footer}</>;
}
