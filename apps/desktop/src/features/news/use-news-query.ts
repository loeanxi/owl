import { createContext, useContext, useEffect, useState } from "react";
import type { NewsRequest, NewsResultByAction } from "../../../../../packages/coding-agent/src/core/news/types.ts";
import { errorText, type NewsClient } from "./news-client.ts";

export const NewsQueryActivity = createContext(true);

export function useNewsQuery<A extends NewsRequest["action"]>(
	api: NewsClient,
	request: Extract<NewsRequest, { action: A }>,
	revision: number,
	enabled = true,
) {
	const key = JSON.stringify(request);
	const active = useContext(NewsQueryActivity) && enabled;
	const [state, setState] = useState<{
		api: NewsClient;
		key: string;
		data?: NewsResultByAction[A];
		pending: boolean;
		error: string;
	}>();
	useEffect(() => {
		if (!active) return;
		let current = true;
		setState((previous) => ({
			api,
			key,
			data: previous?.api === api && previous.key === key ? previous.data : undefined,
			pending: true,
			error: "",
		}));
		void api.query<A>(JSON.parse(key) as Extract<NewsRequest, { action: A }>).then(
			(value) => {
				if (current) setState({ api, key, data: value, pending: false, error: "" });
			},
			(failure: unknown) => {
				if (current)
					setState((previous) => ({
						api,
						key,
						data: previous?.api === api && previous.key === key ? previous.data : undefined,
						pending: false,
						error: errorText(failure),
					}));
			},
		);
		return () => {
			current = false;
		};
	}, [api, key, revision, active]);
	const matches = state?.api === api && state.key === key;
	const data = matches ? state.data : undefined;
	const pending = active && (!matches || state.pending);
	return {
		data,
		loading: pending && data === undefined,
		refreshing: pending && data !== undefined,
		error: matches ? state.error : "",
	};
}
