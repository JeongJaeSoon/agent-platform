import { describe, expect, mock, test } from "bun:test";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { render, waitFor, act } = await setupDom();
// Radix Popover portals only when it found a DOM at import time.
const { Combobox } = await import("./combobox.tsx");
const { Field, FieldLabel } = await import("../primitives/field.tsx");

const MEMBERS = [
  { value: "u1", label: "Kim Minji", description: "minji@example.com" },
  {
    value: "u2",
    label: "Lee Jun",
    description: "jun@example.com",
    disabled: true,
  },
  { value: "u3", label: "Park Sora", description: "sora@example.com" },
  {
    value: "u4",
    label: "Choi Dana",
    description: "dana@example.com",
    disabled: true,
  },
  { value: "u5", label: "Jung Hana", description: "hana@example.com" },
];

function input(getByRole: (role: string) => HTMLElement) {
  return getByRole("combobox") as HTMLInputElement;
}

function optionLabels(getAllByRole: (role: string) => HTMLElement[]) {
  return getAllByRole("option").map(
    (option) => option.querySelector("span span")?.textContent,
  );
}

function activeLabel(box: HTMLInputElement) {
  const id = box.getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.textContent : null;
}

describe("Combobox", () => {
  test("닫혀 있을 때 aria-expanded=false이고 activedescendant·controls가 없다", () => {
    const { getByRole, queryByRole } = render(
      <Combobox aria-label="구성원" options={MEMBERS} emptyMessage="없음" />,
    );
    const box = input(getByRole);
    expect(box.tagName).toBe("INPUT");
    expect(box.getAttribute("aria-expanded")).toBe("false");
    expect(box.getAttribute("aria-autocomplete")).toBe("list");
    expect(box.hasAttribute("aria-activedescendant")).toBe(false);
    expect(box.hasAttribute("aria-controls")).toBe(false);
    expect(queryByRole("listbox")).toBeNull();
  });

  test("입력으로 이름과 보조 텍스트를 대소문자·전각 무시하고 거른다", async () => {
    const user = await setupUser();
    const { getByRole, getAllByRole } = render(
      <Combobox aria-label="구성원" options={MEMBERS} emptyMessage="없음" />,
    );
    const box = input(getByRole);
    await user.type(box, "ＳＯＲＡ");
    expect(box.getAttribute("aria-expanded")).toBe("true");
    expect(box.getAttribute("aria-controls")).toBe(
      getByRole("listbox").getAttribute("id"),
    );
    expect(optionLabels(getAllByRole)).toEqual(["Park Sora"]);
    await user.clear(box);
    await user.type(box, "hana@");
    expect(optionLabels(getAllByRole)).toEqual(["Jung Hana"]);
  });

  test("↑↓ Home End가 비활성 옵션을 건너뛰며 활성을 옮긴다", async () => {
    const user = await setupUser();
    const { getByRole } = render(
      <Combobox aria-label="구성원" options={MEMBERS} emptyMessage="없음" />,
    );
    const box = input(getByRole);
    box.focus();
    await user.keyboard("{ArrowDown}");
    expect(box.getAttribute("aria-expanded")).toBe("true");
    expect(activeLabel(box)).toContain("Kim Minji");
    await user.keyboard("{ArrowDown}");
    expect(activeLabel(box)).toContain("Park Sora");
    await user.keyboard("{ArrowDown}");
    expect(activeLabel(box)).toContain("Jung Hana");
    await user.keyboard("{ArrowDown}");
    expect(activeLabel(box)).toContain("Jung Hana");
    await user.keyboard("{ArrowUp}");
    expect(activeLabel(box)).toContain("Park Sora");
    await user.keyboard("{Home}");
    expect(activeLabel(box)).toContain("Kim Minji");
    await user.keyboard("{End}");
    expect(activeLabel(box)).toContain("Jung Hana");
  });

  test("Enter로 고르면 onValueChange를 부르고 닫고 입력에 label을 둔다", async () => {
    const user = await setupUser();
    const onValueChange = mock();
    const { getByRole, getAllByRole } = render(
      <Combobox
        aria-label="구성원"
        options={MEMBERS}
        emptyMessage="없음"
        onValueChange={onValueChange}
      />,
    );
    const box = input(getByRole);
    box.focus();
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange.mock.calls[0]?.[0]).toBe("u3");
    expect(onValueChange.mock.calls[0]?.[1]).toBe(MEMBERS[2]);
    expect(box.getAttribute("aria-expanded")).toBe("false");
    expect(box.value).toBe("Park Sora");
    // Reopening shows every option again, the chosen one selected.
    await user.keyboard("{ArrowDown}");
    const selected = getAllByRole("option").map((option) =>
      option.getAttribute("aria-selected"),
    );
    expect(selected).toEqual(["false", "false", "true", "false", "false"]);
  });

  test("비활성 옵션은 aria-disabled이고 눌러도 Enter로도 고를 수 없다", async () => {
    const user = await setupUser();
    const onValueChange = mock();
    const { getByRole, getByText } = render(
      <Combobox
        aria-label="구성원"
        options={MEMBERS}
        emptyMessage="없음"
        onValueChange={onValueChange}
      />,
    );
    const box = input(getByRole);
    await user.type(box, "Lee");
    const option = getByText("Lee Jun").closest("[role=option]");
    expect(option?.getAttribute("aria-disabled")).toBe("true");
    await user.click(option as Element);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onValueChange).not.toHaveBeenCalled();
    expect(box.hasAttribute("aria-activedescendant")).toBe(false);
  });

  test("Esc가 목록을 닫고 한 번 더 누르면 입력을 비운다", async () => {
    const user = await setupUser();
    const { getByRole, queryByRole } = render(
      <Combobox aria-label="구성원" options={MEMBERS} emptyMessage="없음" />,
    );
    const box = input(getByRole);
    await user.type(box, "k");
    await user.keyboard("{ArrowDown}");
    expect(box.hasAttribute("aria-activedescendant")).toBe(true);
    await user.keyboard("{Escape}");
    expect(box.getAttribute("aria-expanded")).toBe("false");
    expect(box.hasAttribute("aria-activedescendant")).toBe(false);
    await waitFor(() => expect(queryByRole("listbox")).toBeNull());
    expect(box.value).toBe("k");
    await user.keyboard("{Escape}");
    expect(box.value).toBe("");
  });

  test('filter="none"이면 입력과 상관없이 받은 options를 그대로 보인다', async () => {
    const user = await setupUser();
    const { getByRole, getAllByRole } = render(
      <Combobox
        aria-label="구성원"
        options={MEMBERS}
        emptyMessage="없음"
        filter="none"
      />,
    );
    await user.type(input(getByRole), "zzz");
    expect(getAllByRole("option")).toHaveLength(MEMBERS.length);
  });

  test("onQueryChange는 입력이 debounceMs 멈춘 뒤 한 번만 불린다", async () => {
    // A hand-held clock. Radix sets timers of its own, so only the 250ms ones
    // are counted and fired.
    const pending = new Map<number, () => void>();
    let next = 1;
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    globalThis.setTimeout = ((callback: () => void, ms: number) => {
      const id = next++;
      if (ms === 250) pending.set(id, callback);
      return id;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => {
      pending.delete(id);
    }) as unknown as typeof clearTimeout;
    const onQueryChange = mock();
    try {
      const { getByRole, fireEvent } = {
        ...render(
          <Combobox
            aria-label="구성원"
            options={[]}
            emptyMessage="없음"
            filter="none"
            onQueryChange={onQueryChange}
          />,
        ),
        fireEvent: (await import("@testing-library/react")).fireEvent,
      };
      const box = input(getByRole);
      fireEvent.change(box, { target: { value: "k" } });
      fireEvent.change(box, { target: { value: "ki" } });
      fireEvent.change(box, { target: { value: "kim" } });
      expect(onQueryChange).toHaveBeenCalledTimes(0);
      expect(pending.size).toBe(1);
      act(() => {
        for (const callback of pending.values()) callback();
      });
      expect(onQueryChange).toHaveBeenCalledTimes(1);
      expect(onQueryChange.mock.calls[0]?.[0]).toBe("kim");
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
  });

  test("언마운트하면 남은 디바운스를 부르지 않는다", async () => {
    const onQueryChange = mock();
    const { fireEvent } = await import("@testing-library/react");
    const { getByRole, unmount } = render(
      <Combobox
        aria-label="구성원"
        options={[]}
        emptyMessage="없음"
        filter="none"
        debounceMs={5}
        onQueryChange={onQueryChange}
      />,
    );
    fireEvent.change(input(getByRole), { target: { value: "kim" } });
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onQueryChange).not.toHaveBeenCalled();
  });

  test("loading이면 listbox가 aria-busy이고 로딩 문구를 보이고 알린다", async () => {
    const user = await setupUser();
    const { getByRole, getAllByText } = render(
      <Combobox
        aria-label="구성원"
        options={[]}
        emptyMessage="없음"
        filter="none"
        loading
        loadingMessage="불러오는 중"
      />,
    );
    await user.type(input(getByRole), "k");
    expect(getByRole("listbox").getAttribute("aria-busy")).toBe("true");
    expect(getAllByText("불러오는 중")).toHaveLength(2);
    expect(getByRole("status").textContent).toBe("불러오는 중");
  });

  test("결과가 없으면 빈 listbox를 가리킨 채 빈 결과 문구를 보인다", async () => {
    const user = await setupUser();
    const { getByRole, queryAllByRole, getAllByText } = render(
      <Combobox
        aria-label="구성원"
        options={MEMBERS}
        emptyMessage="맞는 사람이 없습니다"
      />,
    );
    const box = input(getByRole);
    await user.type(box, "zzz");
    const listbox = getByRole("listbox", { name: "구성원" });
    expect(box.getAttribute("aria-controls")).toBe(listbox.id);
    expect(queryAllByRole("option")).toHaveLength(0);
    expect(getAllByText("맞는 사람이 없습니다")).toHaveLength(2);
  });

  test("결과 수 문구를 주면 status가 알린다", async () => {
    const user = await setupUser();
    const { getByRole } = render(
      <Combobox
        aria-label="구성원"
        options={MEMBERS}
        emptyMessage="없음"
        resultCountMessage={(count) => `${count}개 결과`}
      />,
    );
    await user.type(input(getByRole), "na");
    expect(getByRole("status").textContent).toBe("2개 결과");
  });

  test("hasMore면 더 보기 행이 끝에 있고 키보드와 클릭으로 onLoadMore를 부른다", async () => {
    const user = await setupUser();
    const onLoadMore = mock();
    const { getByRole } = render(
      <Combobox
        aria-label="구성원"
        options={MEMBERS}
        emptyMessage="없음"
        filter="none"
        hasMore
        onLoadMore={onLoadMore}
        loadMoreLabel="더 보기"
      />,
    );
    const box = input(getByRole);
    box.focus();
    await user.keyboard("{ArrowDown}{End}");
    const more = getByRole("option", { name: "더 보기" });
    expect(box.getAttribute("aria-activedescendant")).toBe(more.id);
    expect(more.parentElement === getByRole("listbox")).toBe(true);
    expect(more.hasAttribute("aria-selected")).toBe(false);
    await user.keyboard("{Enter}");
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    expect(box.getAttribute("aria-expanded")).toBe("true");
    await user.click(more);
    expect(onLoadMore).toHaveBeenCalledTimes(2);
    expect(document.activeElement === box).toBe(true);
  });

  test("clearOnSelect면 고른 뒤 입력을 비운다", async () => {
    const user = await setupUser();
    const onValueChange = mock();
    const { getByRole, getByText } = render(
      <Combobox
        aria-label="구성원"
        options={MEMBERS}
        emptyMessage="없음"
        clearOnSelect
        onValueChange={onValueChange}
      />,
    );
    const box = input(getByRole);
    await user.type(box, "kim");
    await user.click(getByText("Kim Minji"));
    expect(onValueChange.mock.calls[0]?.[0]).toBe("u1");
    expect(box.value).toBe("");
    expect(box.getAttribute("aria-expanded")).toBe("false");
  });

  test("controlled inputValue는 onInputValueChange로만 바뀐다", async () => {
    const user = await setupUser();
    const onInputValueChange = mock();
    const { getByRole } = render(
      <Combobox
        aria-label="구성원"
        options={MEMBERS}
        emptyMessage="없음"
        inputValue="fixed"
        onInputValueChange={onInputValueChange}
      />,
    );
    const box = input(getByRole);
    await user.type(box, "x");
    expect(onInputValueChange.mock.calls[0]?.[0]).toBe("fixedx");
    expect(box.value).toBe("fixed");
  });

  test("controlled value가 바깥에서 바뀌면 입력이 그 label을 따른다", async () => {
    const view = (value: string | null, options = MEMBERS) => (
      <Combobox
        aria-label="구성원"
        options={options}
        emptyMessage="없음"
        value={value}
      />
    );
    const { getByRole, rerender } = render(view("u3"));
    const box = input(getByRole);
    expect(box.value).toBe("Park Sora");
    rerender(view(null));
    expect(box.value).toBe("");
    // The chosen option arrives after the value, as from a server page.
    rerender(view("u5", []));
    expect(box.value).toBe("");
    rerender(view("u5"));
    expect(box.value).toBe("Jung Hana");
  });

  test("defaultInputValue와 바깥에서 바꾼 inputValue로 거른다", async () => {
    const { getByRole, getAllByRole, unmount } = render(
      <Combobox
        aria-label="구성원"
        options={MEMBERS}
        emptyMessage="없음"
        defaultInputValue="sora"
      />,
    );
    const user = await setupUser();
    await user.click(input(getByRole));
    expect(optionLabels(getAllByRole)).toEqual(["Park Sora"]);
    unmount();
    const view = (inputValue: string) => (
      <Combobox
        aria-label="구성원"
        options={MEMBERS}
        emptyMessage="없음"
        inputValue={inputValue}
      />
    );
    const second = render(view(""));
    await user.click(input(second.getByRole));
    expect(second.getAllByRole("option")).toHaveLength(MEMBERS.length);
    second.rerender(view("hana"));
    expect(optionLabels(second.getAllByRole)).toEqual(["Jung Hana"]);
  });

  test("IME 조합 중 Enter는 고르지 않는다", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const onValueChange = mock();
    const { getByRole } = render(
      <Combobox
        aria-label="구성원"
        options={MEMBERS}
        emptyMessage="없음"
        onValueChange={onValueChange}
      />,
    );
    const box = input(getByRole);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(box.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    expect(onValueChange).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onValueChange).toHaveBeenCalledTimes(1);
  });

  test('filter="none"에서 고르면 남은 디바운스를 버리고 빈 검색어를 바로 보낸다', async () => {
    const { fireEvent } = await import("@testing-library/react");
    const onQueryChange = mock();
    const { getByRole, getByText } = render(
      <Combobox
        aria-label="구성원"
        options={MEMBERS}
        emptyMessage="없음"
        filter="none"
        clearOnSelect
        debounceMs={5}
        onQueryChange={onQueryChange}
      />,
    );
    const box = input(getByRole);
    fireEvent.change(box, { target: { value: "kim" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onQueryChange.mock.calls).toEqual([["kim"]]);
    fireEvent.change(box, { target: { value: "kim p" } });
    fireEvent.click(getByText("Park Sora"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onQueryChange.mock.calls).toEqual([["kim"], [""]]);
    expect(box.value).toBe("");
  });

  test('filter="none"에서 첫 디바운스 전에 골라도 빈 검색어를 보낸다', async () => {
    const { fireEvent } = await import("@testing-library/react");
    const onQueryChange = mock();
    const { getByRole, getByText } = render(
      <Combobox
        aria-label="구성원"
        options={MEMBERS}
        emptyMessage="없음"
        filter="none"
        debounceMs={5}
        onQueryChange={onQueryChange}
      />,
    );
    fireEvent.change(input(getByRole), { target: { value: "p" } });
    fireEvent.click(getByText("Park Sora"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onQueryChange.mock.calls).toEqual([[""]]);
  });

  test("Field 안에서는 FieldLabel이 입력과 목록의 이름이 된다", async () => {
    const user = await setupUser();
    const { getByRole } = render(
      <Field>
        <FieldLabel>추가할 구성원</FieldLabel>
        <Combobox options={MEMBERS} emptyMessage="없음" />
      </Field>,
    );
    const box = getByRole("combobox", { name: "추가할 구성원" });
    await user.click(box);
    expect(
      getByRole("listbox", { name: "추가할 구성원" }).getAttribute("role"),
    ).toBe("listbox");
  });
});
