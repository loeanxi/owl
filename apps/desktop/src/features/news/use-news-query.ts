import { useEffect, useState } from "react";
import type { NewsRequest, NewsResultByAction } from "../../../../../packages/coding-agent/src/core/news/types.ts";
import { errorText, type NewsClient } from "./news-client.ts";

export function useNewsQuery<A extends NewsRequest["action"]>(
	api: NewsClient,
	request: Extract<NewsRequest, { action: A }>,
	revision: number,
) {
	const key = JSON.stringify(request);
	const [data, setData] = useState<NewsResultByAction[A]>();
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	useEffect(() => {
		let current = true;
		setLoading(true);
		setError("");
		setData(undefined);
		void api
			.query<A>(JSON.parse(key) as Extract<NewsRequest, { action: A }>)
			.then(
				(value) => {
					if (current) setData(value);
				},
				(failure: unknown) => {
					if (current) setError(errorText(failure));
				},
			)
			.finally(() => {
				if (current) setLoading(false);
			});
		return () => {
			current = false;
		};
	}, [api, key, revision]);
	return { data, loading, error };
}
