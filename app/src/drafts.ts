import AsyncStorage from "@react-native-async-storage/async-storage";

const keyFor = (slug: string) => `interns.draft.v1.${slug}`;

export async function loadDraft(slug: string): Promise<string> {
  return (await AsyncStorage.getItem(keyFor(slug)).catch(() => null)) ?? "";
}

export async function saveDraft(slug: string, text: string): Promise<void> {
  if (text) await AsyncStorage.setItem(keyFor(slug), text).catch(() => {});
  else await AsyncStorage.removeItem(keyFor(slug)).catch(() => {});
}

export async function clearDraft(slug: string): Promise<void> {
  await AsyncStorage.removeItem(keyFor(slug)).catch(() => {});
}
