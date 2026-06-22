import React, { useRef } from "react";
import { createRoom } from "../TopBar/TopBar";
import { Loader } from "@mantine/core";

export const Create = () => {
  const buttonEl = useRef<HTMLButtonElement>(null);
  setTimeout(() => {
    buttonEl?.current?.click();
  }, 1000);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        width: "100vw",
        height: "100vh",
      }}
    >
      <Loader></Loader>
      <div>Creating room. . .</div>
      <button
        style={{ display: "none" }}
        ref={buttonEl}
        onClick={() => {
          createRoom(
            false,
            new URLSearchParams(window.location.search).get("video") ??
              undefined,
          );
        }}
      />
    </div>
  );
};
