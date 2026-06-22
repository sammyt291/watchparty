import React, { useCallback } from "react";
import { serverPath, softWhite } from "../../utils/utils";
import { ActionIcon, Button, Text } from "@mantine/core";
import Announce from "../Announce/Announce";
import appStyles from "../App/App.module.css";
import {
  IconBrandDiscord,
  IconBrandGithub,
  IconCirclePlusFilled,
} from "@tabler/icons-react";

export async function createRoom(
  openNewTab: boolean | undefined,
  video: string = "",
) {
  const response = await fetch(serverPath + "/createRoom", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      video,
    }),
  });
  const data = await response.json();
  const { name } = data;
  if (openNewTab) {
    window.open("/watch" + name);
  } else {
    window.location.assign("/watch" + name);
  }
}

export const NewRoomButton = (props: {
  size?: string;
  openNewTab?: boolean;
}) => {
  const onClick = useCallback(async () => {
    await createRoom(props.openNewTab);
  }, [props.openNewTab]);
  return (
    <Button
      size={props.size}
      onClick={onClick}
      leftSection={<IconCirclePlusFilled />}
    >
      New Room
    </Button>
  );
};

export const SignInButton = () => null;

export const TopBar = (props: {
  hideNewRoom?: boolean;
  hideSignin?: boolean;
  hideMyRooms?: boolean;
  roomTitle?: string;
  roomDescription?: string;
  roomTitleColor?: string;
}) => {
  return (
    <React.Fragment>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          padding: "4px 8px",
          rowGap: "8px",
        }}
      >
        <a href="/" style={{ display: "flex" }}>
          <img style={{ width: "56px", height: "56px" }} src="/logo192.png" />
          {/* <div
              style={{
                height: '48px',
                width: '48px',
                marginRight: '10px',
                borderRadius: '50%',
                position: 'relative',
                backgroundColor: '#' + colorMappings.blue,
              }}
            >
              <Icon
                inverted
                name="film"
                size="large"
                style={{
                  position: 'absolute',
                  top: 8,
                  width: '100%',
                  margin: '0 auto',
                }}
              />
              <Icon
                inverted
                name="group"
                size="large"
                color="green"
                style={{
                  position: 'absolute',
                  bottom: 8,
                  width: '100%',
                  margin: '0 auto',
                }}
              />
            </div> */}
        </a>
        {props.roomTitle || props.roomDescription ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              marginRight: 10,
              marginLeft: 10,
            }}
          >
            <div
              style={{
                fontSize: "30px",
                lineHeight: "30px",
                color: props.roomTitleColor || softWhite,
                fontWeight: 700,
                letterSpacing: 1,
              }}
            >
              {props.roomTitle?.toUpperCase()}
            </div>
            <Text size="sm" style={{}}>
              {props.roomDescription}
            </Text>
          </div>
        ) : (
          <React.Fragment>
            <a href="/" style={{ display: "flex", textDecoration: "none" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <div
                  style={{
                    textTransform: "uppercase",
                    fontWeight: 700,
                    color: "#2185d0",
                    fontSize: "30px",
                    lineHeight: "30px",
                  }}
                >
                  Watch
                </div>
                <div
                  style={{
                    textTransform: "uppercase",
                    fontWeight: 700,
                    color: "#21ba45",
                    fontSize: "30px",
                    lineHeight: "30px",
                    marginLeft: "auto",
                  }}
                >
                  Party
                </div>
              </div>
            </a>
          </React.Fragment>
        )}
        <Announce />
        <div
          className={appStyles.mobileStack}
          style={{
            display: "flex",
            marginLeft: "auto",
            alignItems: "center",
            gap: "4px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "4px",
            }}
          >
            <ActionIcon
              component="a"
              color="gray"
              size="lg"
              href="https://discord.gg/3rYj5HV"
              target="_blank"
              rel="noopener noreferrer"
              title="Discord"
            >
              <IconBrandDiscord />
            </ActionIcon>
            <ActionIcon
              component="a"
              color="gray"
              size="lg"
              href="https://github.com/howardchung/watchparty"
              target="_blank"
              rel="noopener noreferrer"
              title="GitHub"
            >
              <IconBrandGithub />
            </ActionIcon>
          </div>
          {!props.hideNewRoom && <NewRoomButton openNewTab />}
        </div>
      </div>
    </React.Fragment>
  );
};
