/**
 * https://github.com/kubernetes-client/javascript/issues/392
 *
 */
module.exports = function(RED) {
  "use strict";
  const k8s = require("@kubernetes/client-node");
  const queryString = require("query-string");
  const request = require("request");
  const URI = require("uri-js");

  /**
   * https://nodered.org/docs/creating-nodes/status
   * The shape property can be: ring or dot
   * The fill property can be: red, green, yellow, blue or grey
   */
  const statuses = {
    connecting: { fill: "yellow", shape: "ring", text: "connecting" },
    connected: { fill: "green", shape: "dot", text: "connected" },
    disconnected: { fill: "red", shape: "ring", text: "disconnected" },
    misconfigured: { fill: "red", shape: "ring", text: "misconfigured" },
    error: { fill: "red", shape: "dot", text: "error" },
    sending: { fill: "blue", shape: "dot", text: "sending" },
    receiving: { fill: "blue", shape: "dot", text: "receiving" },
    transfer: { fill: "blue", shape: "dot", text: "transfer" },
    blank: {}
  };

  function KubernetesHttpRequest(kc, msg) {
    return new Promise((resolve, reject) => {
      let endpoint = WatchlessURI(msg.topic);
      msg.method = msg.method || "GET";
      const options = {
        method: msg.method.toUpperCase(),
        url: `${kc.getCurrentCluster().server}${endpoint}`,
        headers: {
          Accept: "application/json",
          "User-Agent": "Node-RED",
          "Content-Type": "application/json"
        },
        json: true
        //agentOptions: {
        //  rejectUnauthorized: false
        //}
      };

      kc.applyToRequest(options);

      if (msg.method.includes("PATCH")) {
        /**
         * https://github.com/kubernetes/community/blob/master/contributors/devel/api-conventions.md#patch-operations
         * https://github.com/kubernetes/community/blob/master/contributors/devel/strategic-merge-patch.md
         *
         * Content-Type: application/json-patch+json
         * Content-Type: application/merge-patch+json
         * Content-Type: application/strategic-merge-patch+json
         */
        switch (msg.method) {
          case "PATCH-JSON":
            options["headers"]["Content-Type"] = "application/json-patch+json";
            break;
          case "PATCH-STRATEGIC-MERGE":
            options["headers"]["Content-Type"] =
              "application/strategic-merge-patch+json";
            break;
          case "PATCH":
          case "PATCH-MERGE":
          default:
            options["headers"]["Content-Type"] = "application/merge-patch+json";
            break;
        }

        options.method = "PATCH";
      }

      switch (options.method.toUpperCase()) {
        case "GET":
          options.qs = msg.payload;
          break;
        default:
          options.body = msg.payload;
          break;
      }

      request(options, function(err, res, body) {
        if (err) {
          reject(err);
        }
        resolve(res);
      });
    });
  }

  /**
   * Given a URI, remove parts of the path that equal 'watch'
   * and also remove any 'watch' parameters from the query string
   *
   * @param {*} uri
   */
  function WatchlessURI(uri) {
    const suri = URI.parse(URI.normalize(uri));
    const path = suri.path;
    const query = suri.query;

    const pathParts = path.split("/");
    const pathPartsWithoutWatch = pathParts.filter(item => {
      if (item.toLowerCase() != "watch") {
        return true;
      }
      return false;
    });

    const squery = queryString.parse(query);
    delete squery["watch"];

    const newPath = pathPartsWithoutWatch.join("/");
    const newUri = URI.serialize({
      path: newPath,
      query: queryString.stringify(squery)
    });

    return newUri;
  }

  function KubernetesClientConfigNode(n) {
    RED.nodes.createNode(this, n);
    this.options = {};
  }

  RED.nodes.registerType(
    "kubernetes-client-config",
    KubernetesClientConfigNode,
    {
      credentials: {
        kubeConfig: { type: "text" }
      }
    }
  );

  /**
   * TODO: could have more intelligent reconnect strategy
   *
   * @param {*} n
   */
  function KubernetesClientWatchNode(n) {
    RED.nodes.createNode(this, n);

    this.options = {
      endpoint: n.endpoint,
      activityTimeout:
        parseInt(n.activityTimeout) >= 0 ? parseInt(n.activityTimeout) : 90,
      initialResourceVersionStrategy: n.initialResourceVersionStrategy || "",
      goneResourceVersionStrategy: n.goneResourceVersionStrategy || ""
    };

    const node = this;
    node.lastMessageTimestamp = 0;
    this.kubernetesClientConfig = n.kubernetesClientConfig;
    this.kubernetesClientConfigNode = RED.nodes.getNode(
      this.kubernetesClientConfig
    );

    const kc = new k8s.KubeConfig();
    const watch = new k8s.Watch(kc);
    const endpoint = node.options.endpoint;
    const endpointHash = require("crypto")
      .createHash("md5")
      .update(`${node.kubernetesClientConfig}:${endpoint}`)
      .digest("hex");
    let endpointHashHasBeenSet = false;
    let connecting = false;
    let resourceVersion = false;
    let latestResourceVersion = null;
    let forcedResourceVersion = false;
    let triggerWatchViaShortInterval = false;
    let shortIntervalSeconds = 10;

    if (node.kubernetesClientConfigNode.credentials.kubeConfig) {
      kc.loadFromString(node.kubernetesClientConfigNode.credentials.kubeConfig);
    } else {
      kc.loadFromDefault();
    }

    node.startWatch = async function() {
      if (node.watch) {
        node.watch.abort();
        node.watch.destroy();
        delete node.watch;
      }

      if (connecting == true) {
        return;
      }

      node.status(statuses.connecting);
      connecting = true;

      /**
       * https://kubernetes.io/docs/reference/using-api/api-concepts/#resource-versions
       * 0 vs null have special meaning with watches, carefully choose
       */
      if (forcedResourceVersion !== false) {
        resourceVersion = forcedResourceVersion;
        forcedResourceVersion = false;
      } else if (latestResourceVersion) {
        resourceVersion = latestResourceVersion;
      } else if (resourceVersion !== false) {
        resourceVersion = resourceVersion;
      } else {
        switch (node.options.initialResourceVersionStrategy) {
          case "CURRENT":
            try {
              const res = await KubernetesHttpRequest(kc, {
                topic: endpoint,
                payload: { limit: 1 }
              });

              if (res.statusCode == 200) {
                resourceVersion = res.body.metadata.resourceVersion;
              } else {
                resourceVersion = null;
              }
            } catch (err) {
              node.error(err);
              resourceVersion = null;
            }

            break;
          case "NULL":
            resourceVersion = null;
            break;
          case "ZERO":
            resourceVersion = 0;
            break;
          case "RESTORE-NULL":
            if (endpointHash == node.context().get("endpointHash")) {
              resourceVersion = node.context().get("resourceVersion") || null;
            } else {
              resourceVersion = null;
            }
            break;
          case "RESTORE-ZERO":
            if (endpointHash == node.context().get("endpointHash")) {
              resourceVersion = node.context().get("resourceVersion") || null;
            } else {
              resourceVersion = 0;
            }
            break;
          case "RESTORE-CURRENT":
          default:
            if (endpointHash == node.context().get("endpointHash")) {
              resourceVersion = node.context().get("resourceVersion") || null;
            } else {
              try {
                const res = await KubernetesHttpRequest(kc, {
                  topic: endpoint,
                  payload: { limit: 1 }
                });

                if (res.statusCode == 200) {
                  resourceVersion = res.body.metadata.resourceVersion;
                } else {
                  resourceVersion = null;
                }
              } catch (err) {
                node.error(err);
                resourceVersion = null;
              }
            }
            break;
        }
      }

      // final sanity check
      if (resourceVersion !== null && !(resourceVersion >= 0)) {
        resourceVersion = null;
      }

      node.log(
        `watching ${
          kc.getCurrentCluster().server
        }${endpoint} from resourceVersion: ${resourceVersion}`
      );

      node.watch = watch.watch(
        endpoint,
        { resourceVersion },
        async (type, object) => {
          if (type === undefined || object === undefined) {
            return;
          }

          node.lastMessageTimestamp = Math.floor(Date.now() / 1000);

          if (type == "ERROR") {
            node.error(
              `kubernetes watch (${
                kc.getCurrentCluster().server
              }${endpoint}) error - status: ${object.status}, message: ${
                object.message
              }, reason: ${object.reason}, code: ${object.code}`
            );
            const status = JSON.parse(JSON.stringify(statuses.error));
            status.text = status.text + ": " + object.message;
            node.status(status);

            if (
              object.code == 410 &&
              ["Gone", "Expired"].includes(object.reason)
            ) {
              forcedResourceVersion = null;
              switch (node.options.goneResourceVersionStrategy) {
                case "ZERO":
                  forcedResourceVersion = 0;
                  break;
                case "NULL":
                  forcedResourceVersion = null;
                  break;
                case "CURRENT":
                default:
                  try {
                    const res = await KubernetesHttpRequest(kc, {
                      topic: endpoint,
                      payload: { limit: 1 }
                    });

                    if (res.statusCode == 200) {
                      forcedResourceVersion = res.body.metadata.resourceVersion;
                    }
                  } catch (err) {
                    node.error(err);
                  }
                  break;
              }
            }
          }

          if (
            object.metadata.resourceVersion &&
            object.metadata.resourceVersion > Number(latestResourceVersion)
          ) {
            latestResourceVersion = object.metadata.resourceVersion;
            node.context().set("resourceVersion", latestResourceVersion);
            if (endpointHashHasBeenSet === false) {
              node.context().set("endpointHash", endpointHash);
              endpointHashHasBeenSet = true;
            }
          }

          // TODO: perhaps use object.metadata.creationTimestamp to filter out ADDED events on startup

          node.status(statuses.transfer);
          const msg = {};
          msg.payload = { type, object };
          msg.topic = object.metadata.selfLink || "";
          msg.kube = {};
          msg.kube.config = {};
          msg.kube.config.cluster = kc.getCurrentCluster();
          // potential security issue
          //msg.config.context = kc.getCurrentContext();
          //msg.config.user = kc.getCurrentUser();
          node.send(msg);
          node.status(statuses.connected);
        },
        err => {
          connecting = false;
          node.status(statuses.disconnected);
          triggerWatchViaShortInterval = true;
          if (err) {
            node.error(
              `kubernetes watch (${
                kc.getCurrentCluster().server
              }${endpoint}) error: ${err}`
            );
            const status = JSON.parse(JSON.stringify(statuses.error));
            status.text = status.text + ": " + err;
            node.status(status);

            if (err.code == "ETIMEDOUT") {
              node.log(
                `attempting connect to kubernetes watch (${
                  kc.getCurrentCluster().server
                }${endpoint}) due to connect timeout`
              );
            } else if (err == "resourceVersion stale") {
              node.log(
                `attempting connect to kubernetes watch (${
                  kc.getCurrentCluster().server
                }${endpoint}) due to stale resourceVersion`
              );
            } else {
              node.log(
                `attempting connect to kubernetes watch (${
                  kc.getCurrentCluster().server
                }${endpoint}) due to ${err}`
              );
            }
          } else {
            node.log(
              `attempting connect to kubernetes watch (${
                kc.getCurrentCluster().server
              }${endpoint}) due to unknown connection closure`
            );
          }
        }
      );

      node.watch.on("socket", socket => {});

      node.watch.on("error", err => {});

      node.watch.on("close", () => {});

      node.watch.on("response", response => {
        connecting = false;
        if (response.statusCode == 200) {
          node.status(statuses.connected);
        }
      });
    };

    node.on("close", (removed, done) => {
      if (removed) {
        // This node has been deleted
      } else {
        // This node is being restarted
      }
      if (node.watch) {
        node.watch.abort();
        node.watch.destroy();
        delete node.watch;
      }

      if (node.activityTimeoutInterval) {
        clearInterval(node.activityTimeoutInterval);
      }

      if (node.shortInterval) {
        clearInterval(node.shortInterval);
      }

      done();
    });

    if (node.kubernetesClientConfig) {
      node.startWatch();

      if (node.activityTimeoutInterval) {
        clearInterval(node.activityTimeoutInterval);
      }

      if (node.options.activityTimeout > 0) {
        node.activityTimeoutInterval = setInterval(() => {
          const currentTimestamp = Math.floor(Date.now() / 1000);
          if (
            !connecting &&
            currentTimestamp - node.lastMessageTimestamp >
              node.options.activityTimeout
          ) {
            node.log(
              `attempting reconnect to kubernetes watch (${
                kc.getCurrentCluster().server
              }${endpoint}) due to inactivity timeout`
            );
            node.startWatch();
          }
        }, node.options.activityTimeout * 1000);
      }

      if (node.shortInterval) {
        clearInterval(node.shortInterval);
      }
      node.shortInterval = setInterval(() => {
        if (!connecting && triggerWatchViaShortInterval) {
          triggerWatchViaShortInterval = false;
          node.log(
            `attempting reconnect to kubernetes watch (${
              kc.getCurrentCluster().server
            }${endpoint}) due to short interval trigger`
          );
          node.startWatch();
        }
      }, shortIntervalSeconds * 1000);
    } else {
      node.error("missing KubeConfig");
      node.status(statuses.misconfigured);
    }
  }
  RED.nodes.registerType("kubernetes-client-watch", KubernetesClientWatchNode);

  /**
   * TODO: support new option to 'continue' through the pages of responses
   *
   * @param {*} n
   */
  function KubernetesClientHttpNode(n) {
    RED.nodes.createNode(this, n);

    this.options = {};

    const node = this;
    node.lastMessageTimestamp = 0;
    this.kubernetesClientConfig = n.kubernetesClientConfig;
    this.kubernetesClientConfigNode = RED.nodes.getNode(
      this.kubernetesClientConfig
    );

    const kc = new k8s.KubeConfig();
    if (node.kubernetesClientConfigNode.credentials.kubeConfig) {
      kc.loadFromString(node.kubernetesClientConfigNode.credentials.kubeConfig);
    } else {
      kc.loadFromDefault();
    }

    if (node.kubernetesClientConfig) {
      node.on("input", async function(msg, send, done) {
        node.status(statuses.sending);

        // support of 1.0+ and pre-1.0
        send =
          send ||
          function() {
            node.send.apply(node, arguments);
          };

        try {
          /**
           * Properties of the response include:
           *
           * statusCode
           * body
           * headers
           * request
           */
          let res = await KubernetesHttpRequest(kc, msg);
          msg.payload = res.body;
          msg.kube = {};
          msg.kube.response = JSON.parse(JSON.stringify(res));
          msg.kube.config = {};
          msg.kube.config.cluster = kc.getCurrentCluster();
          send(msg);
          node.status(statuses.blank);
          if (done) {
            done();
          }
        } catch (err) {
          const status = JSON.parse(JSON.stringify(statuses.error));
          status.text = status.text + ": " + err;
          node.status(status);

          // Report back the error
          if (done) {
            // Use done if defined (1.0+)
            done(err);
          } else {
            // Fallback to node.error (pre-1.0)
            node.error(err, msg);
          }
        }
      });
    } else {
      node.error("missing KubeConfig");
      node.status(statuses.misconfigured);
    }
  }
  RED.nodes.registerType("kubernetes-client-http", KubernetesClientHttpNode);
};
