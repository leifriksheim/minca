// Spec 07 §9 has readers refuse a redirected username lookup, so minca.social
// answers for its names itself, by passing the request to the name service.
const NAME_SERVICE = 'https://usernames.minca.social';

export const onRequest = ({ request }: { request: Request }): Promise<Response> => {
  const { pathname, search } = new URL(request.url);
  return fetch(new Request(NAME_SERVICE + pathname + search, request));
};
