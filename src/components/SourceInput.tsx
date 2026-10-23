"use client";

import { useEffect, useId, useState, type InputHTMLAttributes } from "react";
import { listSourcesAction } from "@/app/actions";
import { DEFAULT_SOURCES } from "@/lib/data/sources";
import { Input } from "./ui";

// Fetched each time a box opens: a source typed a minute ago must already be in the list.
const load = () =>
  listSourcesAction()
    .then((r) => (r.ok ? r.data : [...DEFAULT_SOURCES]))
    .catch(() => [...DEFAULT_SOURCES]);

/** A text box that suggests the sources already in use, so "Referral" and "referral" stay one source. */
export function SourceInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const [options, setOptions] = useState<string[]>([...DEFAULT_SOURCES]);
  useEffect(() => {
    let live = true;
    void load().then((o) => live && setOptions(o));
    return () => {
      live = false;
    };
  }, []);
  return (
    <>
      <Input {...props} list={id} maxLength={100} autoComplete="off" />
      <datalist id={id}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  );
}
