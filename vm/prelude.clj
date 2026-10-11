;; The script API of codemode_clj. Loaded into the VM before the tools namespace and the script.
;; Everything a script can do to the outside world goes through codemode.host, which main.go
;; defines on top of the host imports.

(ns codemode)

(def ^:private input (json/read-json (codemode.host/input)))

(defn- decode [s]
  (when (pos? (count s))
    (json/read-json s {:keywords? true})))

(defn- host-call [kind name args]
  (let [reply (codemode.host/call kind name (json/write-json args))
        body (subs reply 1)]
    (if (= "+" (subs reply 0 1))
      (decode body)
      (throw (ex-info body (if (= kind "tool") {:tool name} {}))))))

(defn call-tool
  "Call a tool by its name, for names that are not valid symbols in the tools namespace."
  ([name] (call-tool name {}))
  ([name args] (host-call "tool" name (or args {}))))

(defn text
  "Add a text item to the output: strings as they are, other values printed readably."
  [value]
  (codemode.host/emit 0 (if (string? value) value (pr-str value)))
  nil)

(defn image
  "Add an image to the output: a base64 data URL, a map with :image_url, or an image block
  {:type \"image\" :data <base64> :mimeType ...} as tools return them."
  [value]
  (host-call "global" "image" [value])
  nil)

(defn exit
  "End the script successfully."
  []
  (codemode.host/exit)
  (throw (ex-info "exit" {})))

(def ^:private stored-values
  (atom (into {} (map (fn [[k v]] [k (decode v)]) (get input "store")))))

(defn store
  "Keep a JSON-compatible value under a string key for later codemode calls."
  [key value]
  (let [json-text (json/write-json value)]
    (codemode.host/emit 4 (json/write-json [key json-text]))
    (swap! stored-values assoc key (decode json-text))
    nil))

(defn stored
  "The value kept under key by this or an earlier script, or nil."
  [key]
  (get @stored-values key))

(def all-tools
  "Every callable tool as {:name ... :description ...}."
  (mapv (fn [tool] {:name (get tool "name") :description (get tool "description")})
        (get input "catalog")))

(defn search-tools
  "Rank callable tools by relevance to query. Options: :limit, :namespace."
  ([query] (search-tools query {}))
  ([query options] (host-call "global" "search-tools" [query options])))

(defn describe-tool
  "A tool's description and parameter schema, or nil."
  [name]
  (host-call "global" "describe-tool" [name]))

(defn describe-namespace
  "{:name :description :instructions :tools} of a tool namespace such as an MCP server, or nil."
  [name]
  (host-call "global" "describe-namespace" [name]))

(defn return-value [value]
  (codemode.host/emit 2 (if (string? value) value (pr-str value)))
  nil)

(in-ns 'user)

(def text codemode/text)
(def image codemode/image)
(def exit codemode/exit)
(def store codemode/store)
(def stored codemode/stored)
(def all-tools codemode/all-tools)
(def search-tools codemode/search-tools)
(def describe-tool codemode/describe-tool)
(def describe-namespace codemode/describe-namespace)
