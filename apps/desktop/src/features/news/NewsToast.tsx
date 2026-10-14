import { useEffect, useState } from "react";

export function useNewsToast(): [React.JSX.Element | null, (message: string) => void] {
	const [message, setMessage] = useState("");
	const [serial, setSerial] = useState(0);
	useEffect(() => {
		if (!message) return;
		const timer = setTimeout(() => setMessage(""), 1800);
		return () => clearTimeout(timer);
	}, [message, serial]);
	const node = message ? (
		<div className="owl-news-toast" role="status">
			<span>{message}</span>
		</div>
	) : null;
	return [
		node,
		(next) => {
			setMessage(next);
			setSerial((current) => current + 1);
		},
	];
}
