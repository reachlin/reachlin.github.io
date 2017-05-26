---
title: prometheus confusing config
---

Let's talk about those confusing configurations in Prometheus.

Remember, there are default values for each item if it's missing:

- regex is (.*), which is any string.
- replacement is $1, which is the first match
- separator is ";", items in source_labels will be concatenated with ";" as a single string.
- action is "replace"


Some examples from relabel_configs with explains in details:

1.
```
  - source_labels: [__meta_kubernetes_service_annotation_prometheus_io_scrape]
    action: keep
    regex: true
```
Keep targets with label __meta_kubernetes_service_annotation_prometheus_io_scrape equals 'true',
which means the user added "prometheus.io/scrape: true" in the service's annotation to enable Prometheus scraping.

2.
```
  - source_labels: [__meta_kubernetes_service_annotation_prometheus_io_scheme]
    action: replace
    target_label: __scheme__
    regex: (https?)
```
If __meta_kubernetes_service_annotation_prometheus_io_scheme is http or https, put its value that is the default replacement: $1 into a label called __scheme__. This means the user added prometheus.io/scheme in the service's annotation.

3.
```
  - source_labels: [__meta_kubernetes_service_annotation_prometheus_io_path]
    action: replace
    target_label: __metrics_path__
    regex: (.+)
```
This is also often found in the service annotation for Prometheus scraping, if the user overrides the scrape path, its value will be put in __metrics_path__

4.
```
  - source_labels: [__address__, __meta_kubernetes_service_annotation_prometheus_io_port]
    action: replace
    target_label: __address__
    regex: (.+)(?::\d+);(\d+)
    replacement: $1:$2
```
If the user added prometheus.io/port in the service annotation, use this port to replace the port in __address__."(?:" is a non capture group. e.g. "localhost:80;8080" will become "localhost:8080".
FYI, all above rules are handling Prometheus annotation: https://github.com/prometheus/prometheus/blob/master/documentation/examples/prometheus-kubernetes.yml

5.
```
  - action: labelmap
    regex: __meta_kubernetes_service_label_(.+)
```
Copy labels contain __meta_kubernetes_service_label_ into labels removed the string, e.g. __meta_kubernetes_service_label_app='api' to app='api'

6.
```
  - source_labels: [__meta_kubernetes_namespace]
    action: replace
    target_label: kubernetes_namespace
```
Put any string in __meta_kubernetes_namespace into the label kubernetes_namespace.
